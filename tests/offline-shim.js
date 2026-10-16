if (!OfflineAudioContext.prototype.suspend) {
  const Native = OfflineAudioContext;
  const clock = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime').get;
  window.OfflineAudioContext = class extends Native {
    constructor(...args) {
      super(...args);
      const pending = [];
      let virtual = null;
      Object.defineProperty(this, 'currentTime', { configurable: true, get: () => virtual ?? clock.call(this) });
      this.suspend = (time) => new Promise((resolve) => pending.push({ time, resolve }));
      this.resume = () => Promise.resolve();
      const render = Native.prototype.startRendering.bind(this);
      this.startRendering = async () => {
        pending.sort((a, b) => a.time - b.time);
        for (const { time, resolve } of pending) {
          virtual = time;
          resolve();
          await new Promise((r) => setTimeout(r, 0));
        }
        virtual = null;
        return render();
      };
    }
  };
}
