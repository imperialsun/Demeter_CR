export type CloudSegmentWindow = {
  startSec: number;
  endSec: number;
};

export function splitCloudSegmentWindow(
  segment: CloudSegmentWindow
): [CloudSegmentWindow, CloudSegmentWindow] | null {
  const chunkDurationSec = Math.max(0, segment.endSec - segment.startSec);
  if (!(chunkDurationSec > 1)) {
    return null;
  }

  const splitAt = segment.startSec + chunkDurationSec / 2;
  return [
    { startSec: segment.startSec, endSec: splitAt },
    { startSec: splitAt, endSec: segment.endSec },
  ];
}
