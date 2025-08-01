import { mergeClasses } from '@expo/styleguide';
import { AppleAppStoreIcon } from '@expo/styleguide-icons/custom/AppleAppStoreIcon';
import { Cloud01DuotoneIcon } from '@expo/styleguide-icons/duotone/Cloud01DuotoneIcon';
import { ArrowRightIcon } from '@expo/styleguide-icons/outline/ArrowRightIcon';

import { GridContainer, GridCell, HomeButton } from '~/ui/components/Home/components';
import { QuickStartIcon, DevicesImage } from '~/ui/components/Home/resources';
import { Terminal } from '~/ui/components/Snippet';
import { H1, CALLOUT, A, P } from '~/ui/components/Text';

export function QuickStart() {
  return (
    <>
      <H1 className="mt-1 border-0 pb-0 !font-extrabold">
        Create amazing apps that run everywhere
      </H1>
      <P className="mb-2 text-secondary">
        Build one JavaScript/TypeScript project that runs natively on all your users' devices.
      </P>
      <GridContainer>
        <GridCell
          className={mergeClasses(
            'min-h-[192px] bg-element !bg-cell-quickstart-pattern bg-blend-multiply'
          )}>
          <div
            className={mergeClasses(
              'absolute inset-0 size-full rounded-lg bg-gradient-to-b from-subtle from-15% to-[#21262d00]',
              'dark:from-[#181a1b]'
            )}
          />
          <div className="relative z-10 flex flex-col gap-4">
            <h2 className="font-bold heading-xl">
              <QuickStartIcon /> Quick Start
            </h2>
            <div>
              <Terminal
                cmd={['$ npx create-expo-app@latest']}
                className="asset-shadow rounded-md"
              />
              <CALLOUT theme="secondary">
                Then continue{' '}
                <A href="/get-started/set-up-your-environment">setting up your environment</A>.
              </CALLOUT>
            </div>
          </div>
        </GridCell>
        <GridCell
          className={mergeClasses(
            'relative z-0 min-h-[192px] border-palette-blue6 bg-palette-blue4 !bg-cell-tutorial-pattern bg-blend-multiply',
            'dark:bg-palette-blue3 dark:bg-blend-color-burn'
          )}>
          <div
            className={mergeClasses(
              'absolute inset-0 size-full rounded-lg bg-gradient-to-b from-palette-blue3 from-15% to-[#201d5200]',
              'dark:from-palette-blue3 dark:to-transparent'
            )}
          />
          <DevicesImage />
          <h2 className="relative z-10 max-w-[24ch] font-bold text-palette-blue12 heading-xl">
            Create a universal Android, iOS, and web app
          </h2>
          <HomeButton
            className="hocus:bg-button-primary"
            href="/tutorial/introduction/"
            rightSlot={<ArrowRightIcon className="icon-md" />}>
            Start Tutorial
          </HomeButton>
        </GridCell>
        <GridCell
          className={mergeClasses(
            'min-h-[192px] bg-subtle bg-gradient-to-br from-subtle from-15% to-palette-purple3',
            'selection:bg-palette-purple5'
          )}>
          <AppleAppStoreIcon className="absolute -bottom-16 -right-10 size-72 text-palette-purple10 opacity-10" />
          <div className="relative z-10 flex flex-col gap-4">
            <h2 className="flex items-center gap-2 !font-bold !text-palette-purple10 heading-lg">
              <AppleAppStoreIcon className="icon-lg text-palette-purple10" /> Deploy to TestFlight
            </h2>
            <div>
              <Terminal cmd={['$ npx testflight']} className="asset-shadow rounded-md" />
              <CALLOUT theme="secondary">
                This is an iOS-only command that will upload your app to TestFlight.
              </CALLOUT>
            </div>
          </div>
        </GridCell>
        <GridCell
          className={mergeClasses(
            'min-h-[192px] bg-subtle bg-gradient-to-br from-subtle from-15% to-palette-green3',
            'selection:bg-palette-green4'
          )}>
          <Cloud01DuotoneIcon className="absolute -bottom-20 -right-8 size-80 text-[#1e8a5f] opacity-10 dark:text-[#4eca8c]" />
          <div className="relative z-10 flex flex-col gap-4">
            <h2 className="flex items-center gap-2 !font-bold !text-[#1e8a5f] heading-lg dark:!text-[#4eca8c]">
              <Cloud01DuotoneIcon className="icon-lg text-[#1e8a5f] dark:text-[#4eca8c]" /> Deploy
              your web app
            </h2>
            <div>
              <Terminal cmd={['$ npx eas-cli deploy']} className="asset-shadow rounded-md" />
              <CALLOUT theme="secondary">
                For prerequisites and complete instructions, see{' '}
                <A href="/deploy/web/#export-your-web-project/">our guide</A>.
              </CALLOUT>
            </div>
          </div>
        </GridCell>
      </GridContainer>
    </>
  );
}
