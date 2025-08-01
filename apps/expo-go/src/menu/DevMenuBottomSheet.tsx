import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetView,
  useBottomSheetSpringConfigs,
} from '@gorhom/bottom-sheet';
import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import DevMenuBottomSheetContext from './DevMenuBottomSheetContext';
import * as DevMenu from './DevMenuModule';

type Props = {
  uuid: string;
  children?: React.ReactNode;
};

function DevMenuBottomSheet({ children, uuid }: Props) {
  const bottomSheetRef = useRef<BottomSheet | null>(null);

  const onCollapse = useCallback(
    () =>
      new Promise<void>((resolve) => {
        bottomSheetRef.current?.close();

        // still no way to wait for animation to end before the callback, so we wait for 300ms
        setTimeout(() => {
          resolve();
          DevMenu.closeAsync();
        }, 300);
      }),
    []
  );

  const onExpand = useCallback(
    () =>
      new Promise<void>((resolve) => {
        bottomSheetRef.current?.expand();
        setTimeout(() => {
          resolve();
        }, 300);
      }),
    []
  );

  const onChange = useCallback((index: number) => {
    if (index === -1) {
      DevMenu.closeAsync();
    }
  }, []);

  useEffect(() => {
    const closeSubscription = DevMenu.listenForCloseRequests(() => {
      bottomSheetRef.current?.collapse();
      return new Promise<void>((resolve) => {
        resolve();
      });
    });
    return () => {
      closeSubscription.remove();
    };
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} opacity={0.5} appearsOnIndex={0} disappearsOnIndex={-1} />
    ),
    []
  );

  const animationConfigs = useBottomSheetSpringConfigs({
    duration: 350,
    dampingRatio: 0.8,
    overshootClamping: true,
    stiffness: 250,
  });

  return (
    <BottomSheet
      key={uuid}
      enableDynamicSizing
      index={0}
      ref={bottomSheetRef}
      backdropComponent={renderBackdrop}
      handleComponent={null}
      animationConfigs={animationConfigs}
      backgroundStyle={styles.bottomSheetBackground}
      enablePanDownToClose
      onChange={onChange}>
      <DevMenuBottomSheetContext.Provider value={{ collapse: onCollapse, expand: onExpand }}>
        <BottomSheetView style={styles.contentContainerStyle}>{children}</BottomSheetView>
      </DevMenuBottomSheetContext.Provider>
      {/* Adds bottom offset so that no empty space is shown on overdrag */}
      <View style={{ height: 100 }} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  bottomSheetContainer: {
    flex: 1,
  },
  contentContainerStyle: {},
  bottomSheetBackground: {
    backgroundColor: '#f8f8fa',
  },
});

export default DevMenuBottomSheet;
