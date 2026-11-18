import {
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Ratio,
  RotateCcw,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import {
  createThreePreview,
  type ThreePreviewInstance,
} from '../lib/volume/three-preview';
import { PreviewMountController } from '../lib/volume/three-preview/mount-controller';
import type { PreparedVolumeFor3D, VolumeCursor } from '../types';
import { Button } from './Button';

interface VolumeViewport3DProps {
  volume: PreparedVolumeFor3D | null;
  cursor?: VolumeCursor | null;
  axisViewsVisible?: boolean;
  onAxisViewsVisibleChange?: (visible: boolean) => void;
  sidebarVisible?: boolean;
  onSidebarVisibleChange?: (visible: boolean) => void;
  onDownsampledChange?: (downsampled: boolean) => void;
  axisViewsControlsId?: string;
  sidebarControlsId?: string;
}

export function VolumeViewport3D({
  volume,
  cursor = null,
  axisViewsVisible = true,
  onAxisViewsVisibleChange,
  sidebarVisible = true,
  onSidebarVisibleChange,
  onDownsampledChange,
  axisViewsControlsId,
  sidebarControlsId,
}: VolumeViewport3DProps) {
  const { t } = useTranslation();
  const instructionsId = useId();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ThreePreviewInstance | null>(null);
  const cursorRef = useRef<VolumeCursor | null>(cursor);
  const [error, setError] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [planesVisible, setPlanesVisible] = useState(true);
  const planesVisibleRef = useRef(planesVisible);

  useEffect(() => {
    cursorRef.current = cursor;
    instanceRef.current?.focusCursor(cursor);
  }, [cursor]);

  useEffect(() => {
    planesVisibleRef.current = planesVisible;
    instanceRef.current?.setPlanesVisible(planesVisible);
  }, [planesVisible]);

  useEffect(() => {
    onDownsampledChange?.(Boolean(volume?.downsampled));
  }, [onDownsampledChange, volume?.downsampled]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !volume) {
      setError(false);
      setPreviewReady(false);
      return undefined;
    }

    setError(false);
    setPreviewReady(false);

    // A fresh controller per effect run means retry counters and error
    // states never carry over from a previous volume.
    const controller = new PreviewMountController({
      host,
      volume,
      createPreview: (targetHost, targetVolume, { signal }) =>
        createThreePreview(targetHost, targetVolume, { signal }),
      onStateChange: (state) => {
        setPreviewReady(state === 'ready');
        setError(state === 'error');
      },
      onInstance: (instance) => {
        instanceRef.current = instance;
        if (instance) {
          // Apply the values current at mount completion rather than any
          // captured at mount start; the dedicated props effects only re-run
          // when their own dependency changes and would miss a remount.
          instance.focusCursor(cursorRef.current);
          instance.setPlanesVisible(planesVisibleRef.current);
        }
      },
    });
    controller.start();

    return () => {
      // Abort cancels the in-flight rAF, retry timer, ResizeObserver and
      // matchMedia listener, aborts the async preview build, and disposes the
      // live renderer and every GPU resource it owns.
      controller.abort();
      instanceRef.current = null;
    };
  }, [volume]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const instance = instanceRef.current;
    if (!instance) return;
    const rotationStep = (Math.PI / 30) * (event.shiftKey ? 2.5 : 1);

    switch (event.key) {
      case 'ArrowLeft':
        instance.rotateView(-rotationStep, 0);
        break;
      case 'ArrowRight':
        instance.rotateView(rotationStep, 0);
        break;
      case 'ArrowUp':
        instance.rotateView(0, -rotationStep);
        break;
      case 'ArrowDown':
        instance.rotateView(0, rotationStep);
        break;
      case '+':
      case '=':
        instance.zoomView(0.86);
        break;
      case '-':
      case '_':
        instance.zoomView(1 / 0.86);
        break;
      case '0':
        instance.resetView();
        break;
      default:
        return;
    }

    event.preventDefault();
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-black">
      <div
        ref={hostRef}
        id="volume-3d-surface"
        className="focus-surface absolute inset-0 h-full min-h-0 overflow-hidden"
        role="application"
        tabIndex={volume ? 0 : -1}
        aria-label={t('volumeViewport3d.surfaceLabel')}
        aria-describedby={instructionsId}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - 0"
        onKeyDown={handleKeyDown}
        onPointerDown={(event) =>
          event.currentTarget.focus({ preventScroll: true })
        }
      />
      <span id={instructionsId} className="sr-only">
        {t('volumeViewport3d.keyboardInstructions')}
      </span>
      <div className="absolute inset-0 z-20 pointer-events-none">
        <div className="pointer-events-auto absolute inset-x-2 bottom-2 grid grid-cols-2 items-center gap-1 sm:inset-x-auto sm:right-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-expanded={axisViewsVisible}
            aria-controls={axisViewsControlsId}
            onClick={() => onAxisViewsVisibleChange?.(!axisViewsVisible)}
          >
            {axisViewsVisible ? (
              <PanelBottomClose className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PanelBottomOpen className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {axisViewsVisible
              ? t('volumeViewport3d.hideAxisViewsShort')
              : t('volumeViewport3d.showAxisViewsShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-expanded={sidebarVisible}
            aria-controls={sidebarControlsId}
            onClick={() => onSidebarVisibleChange?.(!sidebarVisible)}
          >
            {sidebarVisible ? (
              <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {sidebarVisible
              ? t('volumeViewport3d.hideSidebarShort')
              : t('volumeViewport3d.showSidebarShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-pressed={planesVisible}
            aria-controls="volume-3d-surface"
            onClick={() => setPlanesVisible((current) => !current)}
          >
            <Ratio className="h-3.5 w-3.5" aria-hidden="true" />
            {planesVisible
              ? t('volumeViewport3d.hidePlanesShort')
              : t('volumeViewport3d.showPlanesShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            disabled={!previewReady}
            onClick={() => instanceRef.current?.resetView()}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('volumeViewport3d.resetViewShort')}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/85 px-4 text-center text-xs text-slate-400">
          {t('volumeViewport3d.previewError')}
        </div>
      ) : null}
    </div>
  );
}
