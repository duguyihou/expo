/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { ExpoConfig, getConfig } from '@expo/config';
import { getMetroServerRoot } from '@expo/config/paths';
import * as runtimeEnv from '@expo/env';
import baseJSBundle from '@expo/metro/metro/DeltaBundler/Serializers/baseJSBundle';
import {
  sourceMapGeneratorNonBlocking,
  type SourceMapGeneratorOptions,
} from '@expo/metro/metro/DeltaBundler/Serializers/sourceMapGenerator';
import type {
  Module,
  DeltaResult,
  TransformInputOptions,
} from '@expo/metro/metro/DeltaBundler/types.flow';
import type {
  default as MetroHmrServer,
  Client as MetroHmrClient,
} from '@expo/metro/metro/HmrServer';
import type { GraphRevision } from '@expo/metro/metro/IncrementalBundler';
import type MetroServer from '@expo/metro/metro/Server';
import bundleToString from '@expo/metro/metro/lib/bundleToString';
import getGraphId from '@expo/metro/metro/lib/getGraphId';
import type { TransformProfile } from '@expo/metro/metro-babel-transformer';
import type { CustomResolverOptions } from '@expo/metro/metro-resolver';
import { SerialAsset } from '@expo/metro-config/build/serializer/serializerAssets';
import assert from 'assert';
import chalk from 'chalk';
import path from 'path';
import resolveFrom from 'resolve-from';

import {
  createServerComponentsMiddleware,
  fileURLToFilePath,
} from './createServerComponentsMiddleware';
import { createRouteHandlerMiddleware } from './createServerRouteMiddleware';
import { ExpoRouterServerManifestV1, fetchManifest } from './fetchRouterManifest';
import { instantiateMetroAsync } from './instantiateMetro';
import {
  attachImportStackToRootMessage,
  dropStackIfContainsCodeFrame,
  getErrorOverlayHtmlAsync,
  IS_METRO_BUNDLE_ERROR_SYMBOL,
} from './metroErrorInterface';
import { metroWatchTypeScriptFiles } from './metroWatchTypeScriptFiles';
import {
  getRouterDirectoryModuleIdWithManifest,
  hasWarnedAboutApiRoutes,
  isApiRouteConvention,
  warnInvalidWebOutput,
} from './router';
import { serializeHtmlWithAssets } from './serializeHtml';
import { observeAnyFileChanges, observeFileChanges } from './waitForMetroToObserveTypeScriptFile';
import { BundleAssetWithFileHashes, ExportAssetMap } from '../../../export/saveAssets';
import { Log } from '../../../log';
import { env } from '../../../utils/env';
import { CommandError } from '../../../utils/errors';
import { toPosixPath } from '../../../utils/filePath';
import { getFreePortAsync } from '../../../utils/port';
import { BundlerDevServer, BundlerStartOptions, DevServerInstance } from '../BundlerDevServer';
import {
  cachedSourceMaps,
  evalMetroAndWrapFunctions,
  evalMetroNoHandling,
} from '../getStaticRenderFunctions';
import { ContextModuleSourceMapsMiddleware } from '../middleware/ContextModuleSourceMapsMiddleware';
import { CreateFileMiddleware } from '../middleware/CreateFileMiddleware';
import { DevToolsPluginMiddleware } from '../middleware/DevToolsPluginMiddleware';
import { createDomComponentsMiddleware } from '../middleware/DomComponentsMiddleware';
import { FaviconMiddleware } from '../middleware/FaviconMiddleware';
import { HistoryFallbackMiddleware } from '../middleware/HistoryFallbackMiddleware';
import { InterstitialPageMiddleware } from '../middleware/InterstitialPageMiddleware';
import { resolveMainModuleName } from '../middleware/ManifestMiddleware';
import { RuntimeRedirectMiddleware } from '../middleware/RuntimeRedirectMiddleware';
import { ServeStaticMiddleware } from '../middleware/ServeStaticMiddleware';
import {
  convertPathToModuleSpecifier,
  createBundleUrlPath,
  ExpoMetroOptions,
  createBundleOsPath,
  getAsyncRoutesFromExpoConfig,
  getBaseUrlFromExpoConfig,
  getMetroDirectBundleOptions,
} from '../middleware/metroOptions';
import { prependMiddleware } from '../middleware/mutations';
import { startTypescriptTypeGenerationAsync } from '../type-generation/startTypescriptTypeGeneration';

export type ExpoRouterRuntimeManifest = Awaited<
  ReturnType<typeof import('expo-router/build/static/renderStaticContent').getManifest>
>;

type SSRLoadModuleFunc = <T extends Record<string, any>>(
  filePath: string,
  specificOptions?: Partial<ExpoMetroOptions>,
  extras?: { hot?: boolean }
) => Promise<T>;

interface BundleDirectResult {
  numModifiedFiles: number;
  lastModifiedDate: Date;
  nextRevId: string;
  bundle: string;
  map: string;
  /** Defined if the output is multi-bundle. */
  artifacts?: SerialAsset[];
  assets?: readonly BundleAssetWithFileHashes[];
}

interface MetroModuleContentsResult extends BundleDirectResult {
  filename: string;
}

interface SSRModuleContentsResult extends Omit<BundleDirectResult, 'bundle'> {
  filename: string;
  src: string;
  map: string;
}

const debug = require('debug')('expo:start:server:metro') as typeof console.log;

/** Default port to use for apps running in Expo Go. */
const EXPO_GO_METRO_PORT = 8081;

/** Default port to use for apps that run in standard React Native projects or Expo Dev Clients. */
const DEV_CLIENT_METRO_PORT = 8081;

export class MetroBundlerDevServer extends BundlerDevServer {
  private metro: MetroServer | null = null;
  private hmrServer: MetroHmrServer<MetroHmrClient> | null = null;
  private ssrHmrClients: Map<string, MetroHmrClient> = new Map();
  isReactServerComponentsEnabled?: boolean;
  isReactServerRoutesEnabled?: boolean;

  get name(): string {
    return 'metro';
  }

  async resolvePortAsync(options: Partial<BundlerStartOptions> = {}): Promise<number> {
    const port =
      // If the manually defined port is busy then an error should be thrown...
      options.port ??
      // Otherwise use the default port based on the runtime target.
      (options.devClient
        ? // Don't check if the port is busy if we're using the dev client since most clients are hardcoded to 8081.
          Number(process.env.RCT_METRO_PORT) || DEV_CLIENT_METRO_PORT
        : // Otherwise (running in Expo Go) use a free port that falls back on the classic 8081 port.
          await getFreePortAsync(EXPO_GO_METRO_PORT));

    return port;
  }

  async exportExpoRouterApiRoutesAsync({
    includeSourceMaps,
    outputDir,
    prerenderManifest,
    platform,
  }: {
    includeSourceMaps?: boolean;
    outputDir: string;
    // This does not contain the API routes info.
    prerenderManifest: ExpoRouterServerManifestV1;
    platform: string;
  }): Promise<{ files: ExportAssetMap; manifest: ExpoRouterServerManifestV1<string> }> {
    const { routerRoot } = this.instanceMetroOptions;
    assert(
      routerRoot != null,
      'The server must be started before calling exportExpoRouterApiRoutesAsync.'
    );

    const appDir = path.join(this.projectRoot, routerRoot);
    const manifest = await this.getExpoRouterRoutesManifestAsync({ appDir });

    const files: ExportAssetMap = new Map();

    // Inject RSC middleware.
    const rscPath = '/_flight/[...rsc]';

    if (
      this.isReactServerComponentsEnabled &&
      // If the RSC route is not already in the manifest, add it.
      !manifest.apiRoutes.find((route) => route.page.startsWith('/_flight/'))
    ) {
      debug('Adding RSC route to the manifest:', rscPath);
      // NOTE: This might need to be sorted to the correct spot in the future.
      manifest.apiRoutes.push({
        file: resolveFrom(this.projectRoot, '@expo/cli/static/template/[...rsc]+api.ts'),
        page: rscPath,
        namedRegex: '^/_flight(?:/(?<rsc>.+?))?(?:/)?$',
        routeKeys: { rsc: 'rsc' },
      });
    }

    for (const route of manifest.apiRoutes) {
      const filepath = path.isAbsolute(route.file) ? route.file : path.join(appDir, route.file);
      const contents = await this.bundleApiRoute(filepath, { platform });

      const artifactFilename =
        route.page === rscPath
          ? // HACK: Add RSC renderer to the output...
            convertPathToModuleSpecifier(path.join(outputDir, '.' + rscPath + '.js'))
          : convertPathToModuleSpecifier(
              path.join(outputDir, path.relative(appDir, filepath.replace(/\.[tj]sx?$/, '.js')))
            );

      if (contents) {
        let src = contents.src;

        if (includeSourceMaps && contents.map) {
          // TODO(kitten): Merge the source map transformer in the future
          // https://github.com/expo/expo/blob/0dffdb15/packages/%40expo/metro-config/src/serializer/serializeChunks.ts#L422-L439
          // Alternatively, check whether `sourcesRoot` helps here
          const artifactBasename = encodeURIComponent(path.basename(artifactFilename) + '.map');
          src = src.replace(
            /\/\/# sourceMappingURL=.*/g,
            `//# sourceMappingURL=${artifactBasename}`
          );

          const parsedMap =
            typeof contents.map === 'string' ? JSON.parse(contents.map) : contents.map;
          files.set(artifactFilename + '.map', {
            contents: JSON.stringify({
              version: parsedMap.version,
              sources: parsedMap.sources.map((source: string) => {
                source =
                  typeof source === 'string' && source.startsWith(this.projectRoot)
                    ? path.relative(this.projectRoot, source)
                    : source;
                return convertPathToModuleSpecifier(source);
              }),
              sourcesContent: new Array(parsedMap.sources.length).fill(null),
              names: parsedMap.names,
              mappings: parsedMap.mappings,
            }),
            apiRouteId: route.page,
            targetDomain: 'server',
          });
        }
        files.set(artifactFilename, {
          contents: src,
          apiRouteId: route.page,
          targetDomain: 'server',
        });
      }
      // Remap the manifest files to represent the output files.
      route.file = artifactFilename;
    }

    return {
      manifest: {
        ...manifest,
        htmlRoutes: prerenderManifest.htmlRoutes,
      },
      files,
    };
  }

  async getExpoRouterRoutesManifestAsync({ appDir }: { appDir: string }) {
    // getBuiltTimeServerManifest
    const { exp } = getConfig(this.projectRoot);
    const manifest = await fetchManifest(this.projectRoot, {
      ...exp.extra?.router,
      preserveRedirectAndRewrites: true,
      asJson: true,
      appDir,
    });

    if (!manifest) {
      throw new CommandError(
        'EXPO_ROUTER_SERVER_MANIFEST',
        'Unexpected error: server manifest could not be fetched.'
      );
    }

    return manifest;
  }

  async getServerManifestAsync(): Promise<{
    serverManifest: ExpoRouterServerManifestV1;
    htmlManifest: ExpoRouterRuntimeManifest;
  }> {
    const { exp } = getConfig(this.projectRoot);
    // NOTE: This could probably be folded back into `renderStaticContent` when expo-asset and font support RSC.
    const { getBuildTimeServerManifestAsync, getManifest } = await this.ssrLoadModule<
      typeof import('expo-router/build/static/getServerManifest')
    >('expo-router/build/static/getServerManifest.js', {
      // Only use react-server environment when the routes are using react-server rendering by default.
      environment: this.isReactServerRoutesEnabled ? 'react-server' : 'node',
    });

    return {
      serverManifest: await getBuildTimeServerManifestAsync({ ...exp.extra?.router }),
      htmlManifest: await getManifest({ ...exp.extra?.router }),
    };
  }

  async getStaticRenderFunctionAsync(): Promise<{
    serverManifest: ExpoRouterServerManifestV1;
    manifest: ExpoRouterRuntimeManifest;
    renderAsync: (path: string) => Promise<string>;
  }> {
    const url = this.getDevServerUrlOrAssert();

    const { getStaticContent, getManifest, getBuildTimeServerManifestAsync } =
      await this.ssrLoadModule<typeof import('expo-router/build/static/renderStaticContent')>(
        'expo-router/node/render.js',
        {
          // This must always use the legacy rendering resolution (no `react-server`) because it leverages
          // the previous React SSG utilities which aren't available in React 19.
          environment: 'node',
        }
      );

    const { exp } = getConfig(this.projectRoot);

    return {
      serverManifest: await getBuildTimeServerManifestAsync({
        ...exp.extra?.router,
      }),
      // Get routes from Expo Router.
      manifest: await getManifest({ preserveApiRoutes: false, ...exp.extra?.router }),
      // Get route generating function
      async renderAsync(path: string) {
        return await getStaticContent(new URL(path, url));
      },
    };
  }

  async getStaticResourcesAsync({
    includeSourceMaps,
    mainModuleName,
    clientBoundaries = this.instanceMetroOptions.clientBoundaries ?? [],
    platform = 'web',
  }: {
    includeSourceMaps?: boolean;
    mainModuleName?: string;
    clientBoundaries?: string[];
    platform?: string;
  } = {}) {
    const { mode, minify, isExporting, baseUrl, reactCompiler, routerRoot, asyncRoutes } =
      this.instanceMetroOptions;
    assert(
      mode != null &&
        isExporting != null &&
        baseUrl != null &&
        routerRoot != null &&
        reactCompiler != null &&
        asyncRoutes != null,
      'The server must be started before calling getStaticResourcesAsync.'
    );

    const resolvedMainModuleName =
      mainModuleName ?? './' + resolveMainModuleName(this.projectRoot, { platform });
    return await this.metroImportAsArtifactsAsync(resolvedMainModuleName, {
      splitChunks: isExporting && !env.EXPO_NO_BUNDLE_SPLITTING,
      platform,
      mode,
      minify,
      environment: 'client',
      serializerIncludeMaps: includeSourceMaps,
      mainModuleName: resolvedMainModuleName,
      lazy: !env.EXPO_NO_METRO_LAZY,
      asyncRoutes,
      baseUrl,
      isExporting,
      routerRoot,
      clientBoundaries,
      reactCompiler,
      bytecode: false,
    });
  }

  private async getStaticPageAsync(pathname: string) {
    const { mode, isExporting, clientBoundaries, baseUrl, reactCompiler, routerRoot, asyncRoutes } =
      this.instanceMetroOptions;
    assert(
      mode != null &&
        isExporting != null &&
        baseUrl != null &&
        reactCompiler != null &&
        routerRoot != null &&
        asyncRoutes != null,
      'The server must be started before calling getStaticPageAsync.'
    );
    const platform = 'web';

    const devBundleUrlPathname = createBundleUrlPath({
      splitChunks: isExporting && !env.EXPO_NO_BUNDLE_SPLITTING,
      platform,
      mode,
      environment: 'client',
      reactCompiler,
      mainModuleName: resolveMainModuleName(this.projectRoot, { platform }),
      lazy: !env.EXPO_NO_METRO_LAZY,
      baseUrl,
      isExporting,
      asyncRoutes,
      routerRoot,
      clientBoundaries,
      bytecode: false,
    });

    const bundleStaticHtml = async (): Promise<string> => {
      const { getStaticContent } = await this.ssrLoadModule<
        typeof import('expo-router/build/static/renderStaticContent')
      >('expo-router/node/render.js', {
        // This must always use the legacy rendering resolution (no `react-server`) because it leverages
        // the previous React SSG utilities which aren't available in React 19.
        environment: 'node',
        minify: false,
        isExporting,
        platform,
      });

      const location = new URL(pathname, this.getDevServerUrlOrAssert());
      return await getStaticContent(location);
    };

    const [{ artifacts: resources }, staticHtml] = await Promise.all([
      this.getStaticResourcesAsync({
        clientBoundaries: [],
      }),
      bundleStaticHtml(),
    ]);
    const content = serializeHtmlWithAssets({
      isExporting,
      resources,
      template: staticHtml,
      devBundleUrl: devBundleUrlPathname,
      baseUrl,
      hydrate: env.EXPO_WEB_DEV_HYDRATE,
    });
    return {
      content,
      resources,
    };
  }

  // Set when the server is started.
  private instanceMetroOptions: Partial<ExpoMetroOptions> = {};

  private ssrLoadModule: SSRLoadModuleFunc = async (
    filePath,
    specificOptions = {},
    extras = {}
  ) => {
    const res = await this.ssrLoadModuleContents(filePath, specificOptions);

    if (
      // TODO: hot should be a callback function for invalidating the related SSR module.
      extras.hot &&
      this.instanceMetroOptions.isExporting !== true
    ) {
      // Register SSR HMR
      const serverRoot = getMetroServerRoot(this.projectRoot);
      const relativePath = path.relative(serverRoot, res.filename);
      const url = new URL(relativePath, this.getDevServerUrlOrAssert());
      this.setupHmr(url);
    }

    return evalMetroAndWrapFunctions(
      this.projectRoot,
      res.src,
      res.filename,
      specificOptions.isExporting ?? this.instanceMetroOptions.isExporting!
    );
  };

  private async metroImportAsArtifactsAsync(
    filePath: string,
    specificOptions: Partial<Omit<ExpoMetroOptions, 'serializerOutput'>> = {}
  ) {
    const results = await this.ssrLoadModuleContents(filePath, {
      serializerOutput: 'static',
      ...specificOptions,
    });

    // NOTE: This could potentially need more validation in the future.
    if (results.artifacts && results.assets) {
      return {
        artifacts: results.artifacts,
        assets: results.assets,
        src: results.src,
        filename: results.filename,
        map: results.map,
      };
    }
    throw new CommandError('Invalid bundler results: ' + results);
  }

  private async metroLoadModuleContents(
    filePath: string,
    specificOptions: ExpoMetroOptions,
    extraOptions: {
      sourceMapUrl?: string;
      unstable_transformProfile?: TransformProfile;
    } = {}
  ): Promise<MetroModuleContentsResult> {
    const { baseUrl } = this.instanceMetroOptions;
    assert(baseUrl != null, 'The server must be started before calling metroLoadModuleContents.');

    const opts: ExpoMetroOptions = {
      // TODO: Possibly issues with using an absolute path here...
      // mainModuleName: filePath,
      lazy: false,
      asyncRoutes: false,
      inlineSourceMap: false,
      engine: 'hermes',
      minify: false,
      // bytecode: false,
      // Bundle in Node.js mode for SSR.
      environment: 'node',
      // platform: 'web',
      // mode: 'development',
      //
      ...this.instanceMetroOptions,
      baseUrl,
      // routerRoot,
      // isExporting,
      ...specificOptions,
    };

    const expoBundleOptions = getMetroDirectBundleOptions(opts);

    const resolverOptions = {
      customResolverOptions: expoBundleOptions.customResolverOptions ?? {},
      dev: expoBundleOptions.dev ?? true,
    };

    const transformOptions: TransformInputOptions = {
      dev: expoBundleOptions.dev ?? true,
      hot: true,
      minify: expoBundleOptions.minify ?? false,
      type: 'module',
      unstable_transformProfile:
        extraOptions.unstable_transformProfile ??
        expoBundleOptions.unstable_transformProfile ??
        'default',
      customTransformOptions: expoBundleOptions.customTransformOptions ?? Object.create(null),
      platform: expoBundleOptions.platform ?? 'web',
      // @ts-expect-error: `runtimeBytecodeVersion` does not exist in `expoBundleOptions` or `TransformInputOptions`
      runtimeBytecodeVersion: expoBundleOptions.runtimeBytecodeVersion,
    };

    const resolvedEntryFilePath = await this.resolveRelativePathAsync(filePath, {
      resolverOptions,
      transformOptions,
    });

    const filename = createBundleOsPath({
      ...opts,
      mainModuleName: resolvedEntryFilePath,
    });

    // https://github.com/facebook/metro/blob/2405f2f6c37a1b641cc379b9c733b1eff0c1c2a1/packages/metro/src/lib/parseOptionsFromUrl.js#L55-L87
    const results = await this._bundleDirectAsync(resolvedEntryFilePath, {
      graphOptions: {
        lazy: expoBundleOptions.lazy ?? false,
        shallow: expoBundleOptions.shallow ?? false,
      },
      resolverOptions,
      serializerOptions: {
        ...expoBundleOptions.serializerOptions,

        inlineSourceMap: expoBundleOptions.inlineSourceMap ?? false,
        modulesOnly: expoBundleOptions.modulesOnly ?? false,
        runModule: expoBundleOptions.runModule ?? true,
        // @ts-expect-error
        sourceUrl: expoBundleOptions.sourceUrl,
        // @ts-expect-error
        sourceMapUrl: extraOptions.sourceMapUrl ?? expoBundleOptions.sourceMapUrl,
      },
      transformOptions,
    });

    return {
      ...results,
      filename,
    };
  }

  private async ssrLoadModuleContents(
    filePath: string,
    specificOptions: Partial<ExpoMetroOptions> = {}
  ): Promise<SSRModuleContentsResult> {
    const { baseUrl, routerRoot, isExporting } = this.instanceMetroOptions;
    assert(
      baseUrl != null && routerRoot != null && isExporting != null,
      'The server must be started before calling ssrLoadModuleContents.'
    );

    const opts: ExpoMetroOptions = {
      // TODO: Possibly issues with using an absolute path here...
      mainModuleName: convertPathToModuleSpecifier(filePath),
      lazy: false,
      asyncRoutes: false,
      inlineSourceMap: false,
      engine: 'hermes',
      minify: false,
      bytecode: false,
      // Bundle in Node.js mode for SSR unless RSC is enabled.
      environment: this.isReactServerComponentsEnabled ? 'react-server' : 'node',
      platform: 'web',
      mode: 'development',
      //
      ...this.instanceMetroOptions,

      // Mostly disable compiler in SSR bundles.
      reactCompiler: false,
      baseUrl,
      routerRoot,
      isExporting,

      ...specificOptions,
    };

    // https://github.com/facebook/metro/blob/2405f2f6c37a1b641cc379b9c733b1eff0c1c2a1/packages/metro/src/lib/parseOptionsFromUrl.js#L55-L87
    const { filename, bundle, map, ...rest } = await this.metroLoadModuleContents(filePath, opts);
    const scriptContents = wrapBundle(bundle);

    if (map) {
      debug('Registering SSR source map for:', filename);
      cachedSourceMaps.set(filename, { url: this.projectRoot, map });
    } else {
      debug('No SSR source map found for:', filename);
    }

    return {
      ...rest,
      src: scriptContents,
      filename,
      map,
    };
  }

  async nativeExportBundleAsync(
    exp: ExpoConfig,
    options: Omit<
      ExpoMetroOptions,
      'routerRoot' | 'asyncRoutes' | 'isExporting' | 'serializerOutput' | 'environment'
    >,
    files: ExportAssetMap,
    extraOptions: {
      sourceMapUrl?: string;
      unstable_transformProfile?: TransformProfile;
    } = {}
  ): Promise<{
    artifacts: SerialAsset[];
    assets: readonly BundleAssetWithFileHashes[];
    files?: ExportAssetMap;
  }> {
    if (this.isReactServerComponentsEnabled) {
      return this.singlePageReactServerComponentExportAsync(exp, options, files, extraOptions);
    }

    return this.legacySinglePageExportBundleAsync(options, extraOptions);
  }

  private async singlePageReactServerComponentExportAsync(
    exp: ExpoConfig,
    options: Omit<
      ExpoMetroOptions,
      'baseUrl' | 'routerRoot' | 'asyncRoutes' | 'isExporting' | 'serializerOutput' | 'environment'
    >,
    files: ExportAssetMap,
    extraOptions: {
      sourceMapUrl?: string;
      unstable_transformProfile?: TransformProfile;
    } = {}
  ): Promise<{
    artifacts: SerialAsset[];
    assets: readonly BundleAssetWithFileHashes[];
    files: ExportAssetMap;
  }> {
    const getReactServerReferences = (artifacts: SerialAsset[]): string[] => {
      // Get the React server action boundaries from the client bundle.
      return unique(
        artifacts
          .filter((a) => a.type === 'js')
          .map((artifact) =>
            artifact.metadata.reactServerReferences?.map((ref) => fileURLToFilePath(ref))
          )
          // TODO: Segment by module for splitting.
          .flat()
          .filter(Boolean) as string[]
      );
    };

    // NOTE(EvanBacon): This will not support any code elimination since it's a static pass.
    let {
      reactClientReferences: clientBoundaries,
      reactServerReferences: serverActionReferencesInServer,
      cssModules,
    } = await this.rscRenderer!.getExpoRouterClientReferencesAsync(
      {
        platform: options.platform,
        domRoot: options.domRoot,
      },
      files
    );

    // TODO: The output keys should be in production format or use a lookup manifest.

    const processClientBoundaries = async (
      reactServerReferences: string[]
    ): Promise<{
      artifacts: SerialAsset[];
      assets: readonly BundleAssetWithFileHashes[];
    }> => {
      debug('Evaluated client boundaries:', clientBoundaries);

      // Run metro bundler and create the JS bundles/source maps.
      const bundle = await this.legacySinglePageExportBundleAsync(
        {
          ...options,
          clientBoundaries,
        },
        extraOptions
      );

      // Get the React server action boundaries from the client bundle.
      const newReactServerReferences = getReactServerReferences(bundle.artifacts);

      if (!newReactServerReferences) {
        // Possible issue with babel plugin / metro-config.
        throw new Error(
          'Static server action references were not returned from the Metro client bundle'
        );
      }
      debug('React server action boundaries from client:', newReactServerReferences);

      const allKnownReactServerReferences = unique([
        ...reactServerReferences,
        ...newReactServerReferences,
      ]);

      // When we export the server actions that were imported from the client, we may need to re-bundle the client with the new client boundaries.
      const { clientBoundaries: nestedClientBoundaries } =
        await this.rscRenderer!.exportServerActionsAsync(
          {
            platform: options.platform,
            domRoot: options.domRoot,
            entryPoints: allKnownReactServerReferences,
          },
          files
        );

      // TODO: Check against all modules in the initial client bundles.
      const hasUniqueClientBoundaries = nestedClientBoundaries.some(
        (boundary) => !clientBoundaries.includes(boundary)
      );

      if (!hasUniqueClientBoundaries) {
        return bundle;
      }

      debug('Re-bundling client with nested client boundaries:', nestedClientBoundaries);

      clientBoundaries = unique(clientBoundaries.concat(nestedClientBoundaries));

      // Re-bundle the client with the new client boundaries that only exist in server actions that were imported from the client.
      // Run metro bundler and create the JS bundles/source maps.
      return processClientBoundaries(allKnownReactServerReferences);
    };

    const bundle = await processClientBoundaries(serverActionReferencesInServer);

    // Inject the global CSS that was imported during the server render.
    bundle.artifacts.push(...cssModules);

    const serverRoot = getMetroServerRoot(this.projectRoot);

    // HACK: Maybe this should be done in the serializer.
    const clientBoundariesAsOpaqueIds = clientBoundaries.map((boundary) =>
      // NOTE(cedric): relative module specifiers / IDs should always be POSIX formatted
      toPosixPath(path.relative(serverRoot, boundary))
    );
    const moduleIdToSplitBundle = (
      bundle.artifacts
        .map((artifact) => artifact?.metadata?.paths && Object.values(artifact.metadata.paths))
        .filter(Boolean)
        .flat() as Record<string, string>[]
    ).reduce((acc, paths) => ({ ...acc, ...paths }), {});

    debug('SSR Manifest:', moduleIdToSplitBundle, clientBoundariesAsOpaqueIds);

    const ssrManifest = new Map<string, string>();

    if (Object.keys(moduleIdToSplitBundle).length) {
      clientBoundariesAsOpaqueIds.forEach((boundary) => {
        if (boundary in moduleIdToSplitBundle) {
          ssrManifest.set(boundary, moduleIdToSplitBundle[boundary]);
        } else {
          throw new Error(
            `Could not find boundary "${boundary}" in the SSR manifest. Available: ${Object.keys(moduleIdToSplitBundle).join(', ')}`
          );
        }
      });
    } else {
      // Native apps with bundle splitting disabled.
      debug('No split bundles');
      clientBoundariesAsOpaqueIds.forEach((boundary) => {
        // @ts-expect-error
        ssrManifest.set(boundary, null);
      });
    }

    const routerOptions = exp.extra?.router;

    // Export the static RSC files
    await this.rscRenderer!.exportRoutesAsync(
      {
        platform: options.platform,
        ssrManifest,
        routerOptions,
      },
      files
    );

    // Save the SSR manifest so we can perform more replacements in the server renderer and with server actions.
    files.set(`_expo/rsc/${options.platform}/ssr-manifest.js`, {
      targetDomain: 'server',
      contents:
        'module.exports = ' +
        JSON.stringify(
          // TODO: Add a less leaky version of this across the framework with just [key, value] (module ID, chunk).
          Object.fromEntries(
            Array.from(ssrManifest.entries()).map(([key, value]) => [
              // Must match babel plugin.
              './' + toPosixPath(path.relative(this.projectRoot, path.join(serverRoot, key))),
              [key, value],
            ])
          )
        ),
    });

    return { ...bundle, files };
  }

  async legacySinglePageExportBundleAsync(
    options: Omit<
      ExpoMetroOptions,
      'routerRoot' | 'asyncRoutes' | 'isExporting' | 'serializerOutput' | 'environment'
    >,
    extraOptions: {
      sourceMapUrl?: string;
      unstable_transformProfile?: TransformProfile;
    } = {}
  ): Promise<{ artifacts: SerialAsset[]; assets: readonly BundleAssetWithFileHashes[] }> {
    const { baseUrl, routerRoot, isExporting } = this.instanceMetroOptions;
    assert(options.mainModuleName != null, 'mainModuleName must be provided in options.');
    assert(
      baseUrl != null && routerRoot != null && isExporting != null,
      'The server must be started before calling legacySinglePageExportBundleAsync.'
    );

    const opts: ExpoMetroOptions = {
      ...this.instanceMetroOptions,
      baseUrl,
      routerRoot,
      isExporting,
      ...options,
      environment: 'client',
      serializerOutput: 'static',
    };

    // https://github.com/facebook/metro/blob/2405f2f6c37a1b641cc379b9c733b1eff0c1c2a1/packages/metro/src/lib/parseOptionsFromUrl.js#L55-L87
    if (!opts.mainModuleName.startsWith('/') && !path.isAbsolute(opts.mainModuleName)) {
      opts.mainModuleName = './' + opts.mainModuleName;
    }

    const output = await this.metroLoadModuleContents(opts.mainModuleName, opts, extraOptions);

    return {
      artifacts: output.artifacts!,
      assets: output.assets!,
    };
  }

  async watchEnvironmentVariables() {
    if (!this.instance) {
      throw new Error(
        'Cannot observe environment variable changes without a running Metro instance.'
      );
    }
    if (!this.metro) {
      // This can happen when the run command is used and the server is already running in another
      // process.
      debug('Skipping Environment Variable observation because Metro is not running (headless).');
      return;
    }

    const envFiles = runtimeEnv
      .getFiles(process.env.NODE_ENV)
      .map((fileName) => path.join(this.projectRoot, fileName));

    observeFileChanges(
      {
        metro: this.metro,
        server: this.instance.server,
      },
      envFiles,
      () => {
        debug('Reloading environment variables...');
        // Force reload the environment variables.
        runtimeEnv.load(this.projectRoot, { force: true });
      }
    );
  }

  rscRenderer: Awaited<ReturnType<typeof createServerComponentsMiddleware>> | null = null;

  protected async startImplementationAsync(
    options: BundlerStartOptions
  ): Promise<DevServerInstance> {
    options.port = await this.resolvePortAsync(options);
    this.urlCreator = this.getUrlCreator(options);

    const config = getConfig(this.projectRoot, { skipSDKVersionRequirement: true });
    const { exp } = config;
    // NOTE: This will change in the future when it's less experimental, we enable React 19, and turn on more RSC flags by default.
    const isReactServerComponentsEnabled =
      !!exp.experiments?.reactServerComponentRoutes || !!exp.experiments?.reactServerFunctions;
    const isReactServerActionsOnlyEnabled =
      !exp.experiments?.reactServerComponentRoutes && !!exp.experiments?.reactServerFunctions;
    this.isReactServerComponentsEnabled = isReactServerComponentsEnabled;
    this.isReactServerRoutesEnabled = !!exp.experiments?.reactServerComponentRoutes;

    const useServerRendering = ['static', 'server'].includes(exp.web?.output ?? '');
    const hasApiRoutes = isReactServerComponentsEnabled || exp.web?.output === 'server';
    const baseUrl = getBaseUrlFromExpoConfig(exp);
    const asyncRoutes = getAsyncRoutesFromExpoConfig(exp, options.mode ?? 'development', 'web');
    const routerRoot = getRouterDirectoryModuleIdWithManifest(this.projectRoot, exp);
    const reactCompiler = !!exp.experiments?.reactCompiler;
    const appDir = path.join(this.projectRoot, routerRoot);
    const mode = options.mode ?? 'development';

    const routerOptions = exp.extra?.router;

    if (isReactServerComponentsEnabled && exp.web?.output === 'static') {
      throw new CommandError(
        `Experimental server component support does not support 'web.output: ${exp.web!.output}' yet. Use 'web.output: "server"' during the experimental phase.`
      );
    }

    // Error early about the window.location polyfill when React Server Components are enabled.
    if (isReactServerComponentsEnabled && exp?.extra?.router?.origin === false) {
      const configPath = config.dynamicConfigPath ?? config.staticConfigPath ?? '/app.json';
      const configFileName = path.basename(configPath);
      throw new CommandError(
        `The Expo Router "origin" property in the Expo config (${configFileName}) cannot be "false" when React Server Components is enabled. Remove it from the ${configFileName} file and try again.`
      );
    }

    const instanceMetroOptions = {
      isExporting: !!options.isExporting,
      baseUrl,
      mode,
      routerRoot,
      reactCompiler,
      minify: options.minify,
      asyncRoutes,
      // Options that are changing between platforms like engine, platform, and environment aren't set here.
    };
    this.instanceMetroOptions = instanceMetroOptions;

    const parsedOptions = {
      port: options.port,
      maxWorkers: options.maxWorkers,
      resetCache: options.resetDevServer,
    };

    // Required for symbolication:
    process.env.EXPO_DEV_SERVER_ORIGIN = `http://localhost:${options.port}`;

    const { metro, hmrServer, server, middleware, messageSocket } = await instantiateMetroAsync(
      this,
      parsedOptions,
      {
        isExporting: !!options.isExporting,
        exp,
      }
    );

    if (!options.isExporting) {
      const manifestMiddleware = await this.getManifestMiddlewareAsync(options);

      // Important that we noop source maps for context modules as soon as possible.
      prependMiddleware(middleware, new ContextModuleSourceMapsMiddleware().getHandler());

      // We need the manifest handler to be the first middleware to run so our
      // routes take precedence over static files. For example, the manifest is
      // served from '/' and if the user has an index.html file in their project
      // then the manifest handler will never run, the static middleware will run
      // and serve index.html instead of the manifest.
      // https://github.com/expo/expo/issues/13114
      prependMiddleware(middleware, manifestMiddleware.getHandler());

      middleware.use(
        new InterstitialPageMiddleware(this.projectRoot, {
          // TODO: Prevent this from becoming stale.
          scheme: options.location.scheme ?? null,
        }).getHandler()
      );
      middleware.use(
        new DevToolsPluginMiddleware(this.projectRoot, this.devToolsPluginManager).getHandler()
      );

      const deepLinkMiddleware = new RuntimeRedirectMiddleware(this.projectRoot, {
        getLocation: ({ runtime }) => {
          if (runtime === 'custom') {
            return this.urlCreator?.constructDevClientUrl();
          } else {
            return this.urlCreator?.constructUrl({
              scheme: 'exp',
            });
          }
        },
      });
      middleware.use(deepLinkMiddleware.getHandler());

      const serverRoot = getMetroServerRoot(this.projectRoot);

      const domComponentRenderer = createDomComponentsMiddleware(
        {
          metroRoot: serverRoot,
          projectRoot: this.projectRoot,
        },
        instanceMetroOptions
      );
      // Add support for DOM components.
      // TODO: Maybe put behind a flag for now?
      middleware.use(domComponentRenderer);

      middleware.use(new CreateFileMiddleware(this.projectRoot).getHandler());

      // Append support for redirecting unhandled requests to the index.html page on web.
      if (this.isTargetingWeb()) {
        // This MUST be after the manifest middleware so it doesn't have a chance to serve the template `public/index.html`.
        middleware.use(new ServeStaticMiddleware(this.projectRoot).getHandler());

        // This should come after the static middleware so it doesn't serve the favicon from `public/favicon.ico`.
        middleware.use(new FaviconMiddleware(this.projectRoot).getHandler());
      }

      if (useServerRendering || isReactServerComponentsEnabled) {
        observeAnyFileChanges(
          {
            metro,
            server,
          },
          (events) => {
            if (hasApiRoutes) {
              // NOTE(EvanBacon): We aren't sure what files the API routes are using so we'll just invalidate
              // aggressively to ensure we always have the latest. The only caching we really get here is for
              // cases where the user is making subsequent requests to the same API route without changing anything.
              // This is useful for testing but pretty suboptimal. Luckily our caching is pretty aggressive so it makes
              // up for a lot of the overhead.
              this.invalidateApiRouteCache();
            } else if (!hasWarnedAboutApiRoutes()) {
              for (const event of events) {
                if (
                  // If the user did not delete a file that matches the Expo Router API Route convention, then we should warn that
                  // API Routes are not enabled in the project.
                  event.metadata?.type !== 'd' &&
                  // Ensure the file is in the project's routes directory to prevent false positives in monorepos.
                  event.filePath.startsWith(appDir) &&
                  isApiRouteConvention(event.filePath)
                ) {
                  warnInvalidWebOutput();
                }
              }
            }
          }
        );
      }

      // If React 19 is enabled, then add RSC middleware to the dev server.
      if (isReactServerComponentsEnabled) {
        this.bindRSCDevModuleInjectionHandler();
        const rscMiddleware = createServerComponentsMiddleware(this.projectRoot, {
          instanceMetroOptions: this.instanceMetroOptions,
          rscPath: '/_flight',
          ssrLoadModule: this.ssrLoadModule.bind(this),
          ssrLoadModuleArtifacts: this.metroImportAsArtifactsAsync.bind(this),
          useClientRouter: isReactServerActionsOnlyEnabled,
          createModuleId: metro._createModuleId.bind(metro),
          routerOptions,
        });
        this.rscRenderer = rscMiddleware;
        middleware.use(rscMiddleware.middleware);
        this.onReloadRscEvent = rscMiddleware.onReloadRscEvent;
      }

      // Append support for redirecting unhandled requests to the index.html page on web.
      if (this.isTargetingWeb()) {
        if (!useServerRendering) {
          // This MUST run last since it's the fallback.
          middleware.use(
            new HistoryFallbackMiddleware(manifestMiddleware.getHandler().internal).getHandler()
          );
        } else {
          middleware.use(
            createRouteHandlerMiddleware(this.projectRoot, {
              appDir,
              routerRoot,
              config,
              ...config.exp.extra?.router,
              bundleApiRoute: (functionFilePath) =>
                this.ssrImportApiRoute(functionFilePath, { platform: 'web' }),
              getStaticPageAsync: async (pathname) => {
                // TODO: Add server rendering when RSC is enabled.
                if (isReactServerComponentsEnabled) {
                  // NOTE: This is a temporary hack to return the SPA/template index.html in development when RSC is enabled.
                  // While this technically works, it doesn't provide the correct experience of server rendering the React code to HTML first.
                  const html = await manifestMiddleware.getSingleHtmlTemplateAsync();
                  return { content: html };
                }

                // Non-RSC apps will bundle the static HTML for a given pathname and respond with it.
                return this.getStaticPageAsync(pathname);
              },
            })
          );
        }
      }
    } else {
      // If React 19 is enabled, then add RSC middleware to the dev server.
      if (isReactServerComponentsEnabled) {
        this.bindRSCDevModuleInjectionHandler();
        const rscMiddleware = createServerComponentsMiddleware(this.projectRoot, {
          instanceMetroOptions: this.instanceMetroOptions,
          rscPath: '/_flight',
          ssrLoadModule: this.ssrLoadModule.bind(this),
          ssrLoadModuleArtifacts: this.metroImportAsArtifactsAsync.bind(this),
          useClientRouter: isReactServerActionsOnlyEnabled,
          createModuleId: metro._createModuleId.bind(metro),
          routerOptions,
        });
        this.rscRenderer = rscMiddleware;
      }
    }
    // Extend the close method to ensure that we clean up the local info.
    const originalClose = server.close.bind(server);

    server.close = (callback?: (err?: Error) => void) => {
      return originalClose((err?: Error) => {
        this.instance = null;
        this.metro = null;
        this.hmrServer = null;
        this.ssrHmrClients = new Map();
        callback?.(err);
      });
    };

    this.metro = metro;
    this.hmrServer = hmrServer;
    return {
      server,
      location: {
        // The port is the main thing we want to send back.
        port: options.port,
        // localhost isn't always correct.
        host: 'localhost',
        // http is the only supported protocol on native.
        url: `http://localhost:${options.port}`,
        protocol: 'http',
      },
      middleware,
      messageSocket,
    };
  }

  private onReloadRscEvent: ((platform: string) => void) | null = null;

  private async registerSsrHmrAsync(url: string, onReload: (platform: string[]) => void) {
    if (!this.hmrServer || this.ssrHmrClients.has(url)) {
      return;
    }

    debug('[SSR] Register HMR:', url);

    const sendFn = (message: string) => {
      const data = JSON.parse(String(message)) as { type: string; body: any };

      switch (data.type) {
        case 'bundle-registered':
        case 'update-done':
        case 'update-start':
          break;
        case 'update':
          {
            const update = data.body;
            const {
              isInitialUpdate,
              added,
              modified,
              deleted,
            }: {
              isInitialUpdate?: boolean;
              added: {
                module: [number | string, string];
                sourceURL: string;
                sourceMappingURL: string;
              }[];
              modified: {
                module: [number | string, string];
                sourceURL: string;
                sourceMappingURL: string;
              }[];
              deleted: (number | string)[];
            } = update;

            const hasUpdate = added.length || modified.length || deleted.length;

            // NOTE: We throw away the updates and instead simply send a trigger to the client to re-fetch the server route.
            if (!isInitialUpdate && hasUpdate) {
              // Clear all SSR modules before sending the reload event. This ensures that the next event will rebuild the in-memory state from scratch.
              // @ts-expect-error
              if (typeof globalThis.__c === 'function') globalThis.__c();

              const allModuleIds = new Set(
                [...added, ...modified].map((m) => m.module[0]).concat(deleted)
              );

              const platforms = unique(
                Array.from(allModuleIds)
                  .map((moduleId) => {
                    if (typeof moduleId !== 'string') {
                      return null;
                    }
                    // Extract platforms from the module IDs.
                    return moduleId.match(/[?&]platform=([\w]+)/)?.[1] ?? null;
                  })
                  .filter(Boolean)
              ) as string[];

              onReload(platforms);
            }
          }
          break;
        case 'error':
          // GraphNotFound can mean that we have an issue in metroOptions where the URL doesn't match the object props.
          Log.error('[SSR] HMR Error: ' + JSON.stringify(data, null, 2));

          if (data.body?.type === 'GraphNotFoundError') {
            Log.error(
              'Available SSR HMR keys:',
              // @ts-expect-error
              (this.metro?._bundler._revisionsByGraphId as Map).keys()
            );
          }
          break;
        default:
          debug('Unknown HMR message:', data);
          break;
      }
    };

    const client = await this.hmrServer!.onClientConnect(url, sendFn);
    this.ssrHmrClients.set(url, client);
    // Opt in...
    client.optedIntoHMR = true;
    await this.hmrServer!._registerEntryPoint(client, url, sendFn);
  }

  public async waitForTypeScriptAsync(): Promise<boolean> {
    if (!this.instance) {
      throw new Error('Cannot wait for TypeScript without a running server.');
    }

    return new Promise<boolean>((resolve) => {
      if (!this.metro) {
        // This can happen when the run command is used and the server is already running in another
        // process. In this case we can't wait for the TypeScript check to complete because we don't
        // have access to the Metro server.
        debug('Skipping TypeScript check because Metro is not running (headless).');
        return resolve(false);
      }

      const off = metroWatchTypeScriptFiles({
        projectRoot: this.projectRoot,
        server: this.instance!.server,
        metro: this.metro,
        tsconfig: true,
        throttle: true,
        eventTypes: ['change', 'add'],
        callback: async () => {
          // Run once, this prevents the TypeScript project prerequisite from running on every file change.
          off();
          const { TypeScriptProjectPrerequisite } = await import(
            '../../doctor/typescript/TypeScriptProjectPrerequisite.js'
          );

          try {
            const req = new TypeScriptProjectPrerequisite(this.projectRoot);
            await req.bootstrapAsync();
            resolve(true);
          } catch (error: any) {
            // Ensure the process doesn't fail if the TypeScript check fails.
            // This could happen during the install.
            Log.log();
            Log.error(
              chalk.red`Failed to automatically setup TypeScript for your project. Try restarting the dev server to fix.`
            );
            Log.exception(error);
            resolve(false);
          }
        },
      });
    });
  }

  public async startTypeScriptServices() {
    return startTypescriptTypeGenerationAsync({
      server: this.instance?.server,
      metro: this.metro,
      projectRoot: this.projectRoot,
    });
  }

  protected getConfigModuleIds(): string[] {
    return ['./metro.config.js', './metro.config.json', './rn-cli.config.js'];
  }

  // API Routes

  private pendingRouteOperations = new Map<string, Promise<SSRModuleContentsResult | null>>();

  // Bundle the API Route with Metro and return the string contents to be evaluated in the server.
  private async bundleApiRoute(
    filePath: string,
    { platform }: { platform: string }
  ): Promise<SSRModuleContentsResult | null | undefined> {
    if (this.pendingRouteOperations.has(filePath)) {
      return this.pendingRouteOperations.get(filePath);
    }
    const bundleAsync = async (): Promise<SSRModuleContentsResult> => {
      try {
        debug('Bundle API route:', this.instanceMetroOptions.routerRoot, filePath);
        return await this.ssrLoadModuleContents(filePath, {
          isExporting: this.instanceMetroOptions.isExporting,
          platform,
        });
      } catch (error: any) {
        const appDir = this.instanceMetroOptions?.routerRoot
          ? path.join(this.projectRoot, this.instanceMetroOptions!.routerRoot!)
          : undefined;
        const relativePath = appDir ? path.relative(appDir, filePath) : filePath;

        // Expected errors: invalid syntax, missing resolutions.
        // Wrap with command error for better error messages.
        const err = new CommandError(
          'API_ROUTE',
          chalk`Failed to bundle API Route: {bold ${relativePath}}\n\n` + error.message
        );

        for (const key in error) {
          // @ts-expect-error
          err[key] = error[key];
        }

        throw err;
      } finally {
        // pendingRouteOperations.delete(filepath);
      }
    };
    const route = bundleAsync();

    this.pendingRouteOperations.set(filePath, route);
    return route;
  }

  private async ssrImportApiRoute(
    filePath: string,
    { platform }: { platform: string }
  ): Promise<null | Record<string, Function> | Response> {
    // TODO: Cache the evaluated function.
    try {
      const apiRoute = await this.bundleApiRoute(filePath, { platform });

      if (!apiRoute?.src) {
        return null;
      }
      return evalMetroNoHandling(this.projectRoot, apiRoute.src, apiRoute.filename);
    } catch (error) {
      // Format any errors that were thrown in the global scope of the evaluation.
      if (error instanceof Error) {
        try {
          const htmlServerError = await getErrorOverlayHtmlAsync({
            error,
            projectRoot: this.projectRoot,
            routerRoot: this.instanceMetroOptions.routerRoot!,
          });

          return new Response(htmlServerError, {
            status: 500,
            headers: {
              'Content-Type': 'text/html',
            },
          });
        } catch (internalError) {
          debug('Failed to generate Metro server error UI for API Route error:', internalError);
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  private invalidateApiRouteCache() {
    this.pendingRouteOperations.clear();
  }

  // Ensure the global is available for SSR CSS modules to inject client updates.
  private bindRSCDevModuleInjectionHandler() {
    // Used by SSR CSS modules to broadcast client updates.
    // @ts-expect-error
    globalThis.__expo_rsc_inject_module = this.sendClientModule.bind(this);
  }

  // NOTE: This can only target a single platform at a time (web).
  // used for sending RSC CSS to the root client in development.
  private sendClientModule({ code, id }: { code: string; id: string }) {
    this.broadcastMessage('sendDevCommand', {
      name: 'module-import',
      data: {
        code,
        id,
      },
    });
  }

  // Metro HMR

  private setupHmr(url: URL) {
    const onReload = (platforms: string[] = []) => {
      // Send reload command to client from Fast Refresh code.

      if (!platforms.length) {
        // TODO: When is this called?
        this.broadcastMessage('sendDevCommand', {
          name: 'rsc-reload',
        });
      } else {
        for (const platform of platforms) {
          this.onReloadRscEvent?.(platform);
          this.broadcastMessage('sendDevCommand', {
            name: 'rsc-reload',
            platform,
          });
        }
      }
    };

    this.registerSsrHmrAsync(url.toString(), onReload);
  }

  // Direct Metro access

  // Emulates the Metro dev server .bundle endpoint without having to go through a server.
  private async _bundleDirectAsync(
    resolvedEntryFilePath: string,
    {
      transformOptions,
      resolverOptions,
      graphOptions,
      serializerOptions,
    }: {
      transformOptions: TransformInputOptions;
      resolverOptions: {
        customResolverOptions: CustomResolverOptions;
        dev: boolean;
      };
      serializerOptions: {
        modulesOnly: boolean;
        runModule: boolean;
        sourceMapUrl: string;
        sourceUrl: string;
        inlineSourceMap: boolean;
        excludeSource: boolean;
      };
      graphOptions: {
        shallow: boolean;
        lazy: boolean;
      };
    }
  ): Promise<BundleDirectResult> {
    assert(this.metro, 'Metro server must be running to bundle directly.');
    const config = this.metro._config;
    const buildNumber = this.metro.getNewBuildNumber();
    const bundlePerfLogger = config.unstable_perfLoggerFactory?.('BUNDLING_REQUEST', {
      key: buildNumber,
    });

    const onProgress = (transformedFileCount: number, totalFileCount: number) => {
      this.metro?._reporter?.update?.({
        buildID: getBuildID(buildNumber),
        type: 'bundle_transform_progressed',
        transformedFileCount,
        totalFileCount,
      });
    };

    const revPromise = this.getMetroRevision(resolvedEntryFilePath, {
      graphOptions,
      transformOptions,
      resolverOptions,
    });

    bundlePerfLogger?.point('resolvingAndTransformingDependencies_start');
    bundlePerfLogger?.annotate({
      bool: {
        initial_build: revPromise == null,
      },
    });
    this.metro?._reporter.update({
      buildID: getBuildID(buildNumber),
      bundleDetails: {
        bundleType: transformOptions.type,
        dev: transformOptions.dev,
        entryFile: resolvedEntryFilePath,
        minify: transformOptions.minify,
        platform: transformOptions.platform,
        customResolverOptions: resolverOptions.customResolverOptions,
        customTransformOptions: transformOptions.customTransformOptions ?? {},
      },
      isPrefetch: false,
      type: 'bundle_build_started',
    });

    try {
      let delta: DeltaResult;
      let revision: GraphRevision;

      try {
        // TODO: Some bug in Metro/RSC causes this to break when changing imports in server components.
        // We should resolve the bug because it results in ~6x faster bundling to reuse the graph revision.
        if (transformOptions.customTransformOptions?.environment === 'react-server') {
          const props = await this.metro.getBundler().initializeGraph(
            // NOTE: Using absolute path instead of relative input path is a breaking change.
            // entryFile,
            resolvedEntryFilePath,

            transformOptions,
            resolverOptions,
            {
              onProgress,
              shallow: graphOptions.shallow,
              lazy: graphOptions.lazy,
            }
          );
          delta = props.delta;
          revision = props.revision;
        } else {
          const props = await (revPromise != null
            ? this.metro.getBundler().updateGraph(await revPromise, false)
            : this.metro.getBundler().initializeGraph(
                // NOTE: Using absolute path instead of relative input path is a breaking change.
                // entryFile,
                resolvedEntryFilePath,

                transformOptions,
                resolverOptions,
                {
                  onProgress,
                  shallow: graphOptions.shallow,
                  lazy: graphOptions.lazy,
                }
              ));
          delta = props.delta;
          revision = props.revision;
        }
      } catch (error) {
        attachImportStackToRootMessage(error);
        dropStackIfContainsCodeFrame(error);
        throw error;
      }

      bundlePerfLogger?.annotate({
        int: {
          graph_node_count: revision.graph.dependencies.size,
        },
      });
      bundlePerfLogger?.point('resolvingAndTransformingDependencies_end');
      bundlePerfLogger?.point('serializingBundle_start');

      const shouldAddToIgnoreList = this.metro._shouldAddModuleToIgnoreList.bind(this.metro);

      const serializer = this.getMetroSerializer();

      const bundle = await serializer(
        // NOTE: Using absolute path instead of relative input path is a breaking change.
        // entryFile,
        resolvedEntryFilePath,

        revision.prepend as any,
        revision.graph as any,
        {
          asyncRequireModulePath: await this.metro._resolveRelativePath(
            config.transformer.asyncRequireModulePath,
            {
              relativeTo: 'project',
              resolverOptions,
              transformOptions,
            }
          ),
          // ...serializerOptions,
          processModuleFilter: config.serializer.processModuleFilter,
          createModuleId: this.metro._createModuleId,
          getRunModuleStatement: config.serializer.getRunModuleStatement,
          includeAsyncPaths: graphOptions.lazy,
          dev: transformOptions.dev,
          projectRoot: config.projectRoot,
          modulesOnly: serializerOptions.modulesOnly,
          runBeforeMainModule: config.serializer.getModulesRunBeforeMainModule(
            resolvedEntryFilePath
            // path.relative(config.projectRoot, entryFile)
          ),
          runModule: serializerOptions.runModule,
          sourceMapUrl: serializerOptions.sourceMapUrl,
          sourceUrl: serializerOptions.sourceUrl,
          inlineSourceMap: serializerOptions.inlineSourceMap,
          serverRoot: config.server.unstable_serverRoot ?? config.projectRoot,
          shouldAddToIgnoreList,

          // @ts-expect-error: passed to our serializer to enable non-serial return values.
          serializerOptions,
        }
      );

      this.metro._reporter.update({
        buildID: getBuildID(buildNumber),
        type: 'bundle_build_done',
      });

      bundlePerfLogger?.point('serializingBundle_end');

      let bundleCode: string | null = null;
      let bundleMap: string | null = null;

      // @ts-expect-error: If the output is multi-bundle...
      if (serializerOptions.output === 'static') {
        try {
          const parsed = typeof bundle === 'string' ? JSON.parse(bundle) : bundle;

          assert(
            'artifacts' in parsed && Array.isArray(parsed.artifacts),
            'Expected serializer to return an object with key artifacts to contain an array of serial assets.'
          );

          const artifacts = parsed.artifacts as SerialAsset[];
          const assets = parsed.assets;

          const bundleCode = artifacts.filter((asset) => asset.type === 'js')[0];
          const bundleMap = artifacts.filter((asset) => asset.type === 'map')?.[0]?.source ?? '';

          return {
            numModifiedFiles: delta.reset
              ? delta.added.size + revision.prepend.length
              : delta.added.size + delta.modified.size + delta.deleted.size,
            lastModifiedDate: revision.date,
            nextRevId: revision.id,
            bundle: bundleCode.source,
            map: bundleMap,
            artifacts,
            assets,
          };
        } catch (error: any) {
          throw new Error(
            'Serializer did not return expected format. The project copy of `expo/metro-config` may be out of date. Error: ' +
              error.message
          );
        }
      }

      if (typeof bundle === 'string') {
        bundleCode = bundle;

        // Create the source map in a second pass...
        let { prepend, graph } = revision;
        if (serializerOptions.modulesOnly) {
          prepend = [];
        }

        bundleMap = await sourceMapStringAsync(
          [
            //
            ...prepend,
            ...this.metro._getSortedModules(graph),
          ],
          {
            excludeSource: serializerOptions.excludeSource,
            processModuleFilter: config.serializer.processModuleFilter,
            shouldAddToIgnoreList,
          }
        );
      } else {
        bundleCode = bundle.code;
        bundleMap = bundle.map;
      }

      return {
        numModifiedFiles: delta.reset
          ? delta.added.size + revision.prepend.length
          : delta.added.size + delta.modified.size + delta.deleted.size,
        lastModifiedDate: revision.date,
        nextRevId: revision.id,
        bundle: bundleCode,
        map: bundleMap,
      };
    } catch (error) {
      // Mark the error so we know how to format and return it later.
      // @ts-expect-error
      error[IS_METRO_BUNDLE_ERROR_SYMBOL] = true;

      this.metro._reporter.update({
        buildID: getBuildID(buildNumber),
        type: 'bundle_build_failed',
      });

      throw error;
    }
  }

  private getMetroSerializer() {
    return (
      this.metro?._config?.serializer.customSerializer ||
      ((entryPoint, preModules, graph, options) =>
        bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code)
    );
  }

  private getMetroRevision(
    resolvedEntryFilePath: string,
    {
      graphOptions,
      transformOptions,
      resolverOptions,
    }: {
      transformOptions: TransformInputOptions;
      resolverOptions: {
        customResolverOptions: CustomResolverOptions;
        dev: boolean;
      };
      graphOptions: {
        shallow: boolean;
        lazy: boolean;
      };
    }
  ) {
    assert(this.metro, 'Metro server must be running to bundle directly.');
    const config = this.metro._config;

    const graphId = getGraphId(resolvedEntryFilePath, transformOptions, {
      unstable_allowRequireContext: config.transformer.unstable_allowRequireContext,
      resolverOptions,
      shallow: graphOptions.shallow,
      lazy: graphOptions.lazy,
    });
    return this.metro.getBundler().getRevisionByGraphId(graphId);
  }

  private async resolveRelativePathAsync(
    moduleId: string,
    {
      resolverOptions,
      transformOptions,
    }: {
      transformOptions: TransformInputOptions;
      resolverOptions: {
        customResolverOptions: CustomResolverOptions;
        dev: boolean;
      };
    }
  ) {
    assert(this.metro, 'cannot invoke resolveRelativePathAsync without metro instance');
    return await this.metro._resolveRelativePath(convertPathToModuleSpecifier(moduleId), {
      relativeTo: 'server',
      resolverOptions,
      transformOptions,
    });
  }
}

function getBuildID(buildNumber: number): string {
  return buildNumber.toString(36);
}

function wrapBundle(str: string) {
  // Skip the metro runtime so debugging is a bit easier.
  // Replace the __r() call with an export statement.
  // Use gm to apply to the last require line. This is needed when the bundle has side-effects.
  return str.replace(/^(__r\(.*\);)$/gm, 'module.exports = $1');
}

async function sourceMapStringAsync(
  modules: readonly Module[],
  options: SourceMapGeneratorOptions
): Promise<string> {
  return (await sourceMapGeneratorNonBlocking(modules, options)).toString(undefined, {
    excludeSource: options.excludeSource,
  });
}

function unique<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}
