/* legacy test stub moved to .tsx; keep a skipped suite for test discovery but avoid type errors during build */
declare const describe: any;
declare const it: any;
describe.skip('legacy test stub (moved to .tsx)', () => {
  it('skip', () => {});
});

