# Firefox-404

SP-404 MK2-style effect buses, pads and resampling for any tab's audio. A Firefox add-on (Firefox 142+), plain ES modules, no build step. It's the Firefox version of [Chrome-404](https://github.com/beldorado/Chrome-404).

## Install

1. Clone this repo (`git clone https://github.com/beldorado/Firefox-404.git`), or download it as a ZIP from GitHub and unzip it.
2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and pick `manifest.json` in the `Firefox-404` folder.
3. On a tab that's playing audio, click the Firefox-404 icon, press Alt+Shift+4, or right-click the page and choose **Capture this tab in Firefox-404**. The sidebar opens and the tab's audio runs through the engine.

A temporary add-on stays until Firefox restarts, and your pads, presets and settings are kept between loads. Release Firefox only installs signed add-ons for good. To keep it installed, either sign it for yourself on [addons.mozilla.org](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) (`web-ext sign --channel=unlisted`) or use Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to false in `about:config`.

You can capture several tabs. Tabs that are playing but not captured yet are listed under Sources with a **Capture** button, so you don't have to switch to them.

### How capture works in Firefox

Firefox has no tab-capture API, so Firefox-404 takes the audio from the page's `<audio>` and `<video>` players instead. While a tab is captured, its players play through Firefox-404 and not directly to your speakers. Remove the source (✕) and the page plays on its own again.

- Works with ordinary web players such as YouTube, SoundCloud and Bandcamp.
- DRM-protected playback (Spotify's web player, Netflix and the like) can't be captured, and Firefox gives silence.
- Sound a page makes with Web Audio rather than a player element, and players from another site that don't allow it (no CORS), aren't heard.
- Tab audio arrives about 75 ms later than it would in Chrome-404, from the stream that carries it to the engine. Pads and effects aren't delayed.
- If Firefox hasn't let the page make sound yet, Firefox-404 asks you to click anywhere on that page once.

## Perform view

The panel opens on **Perform**, laid out like the hardware:

- **Screen**: tempo, beat LEDs with bar.beat, the last control you touched, and the level meter.
- **CTRL knobs**: the three main controls of the selected bus's effect. Pick or swap the effect from the menu above them. Buses with a chain show a chip for each effect so you can choose which one the knobs control.
- **Bus FX buttons** (keys 1–6): tap to switch a bus on or off, or hold to play it only while held. Each bus remembers the last settings of every effect you've used on it.
- **Pads** (keys Q W E R / A S D F / Z X C V play the visible bank, laid out like the pads): 12 pads per bank in Loop, Gate or One-shot mode. Loops start on the grid. The menu above the pads picks where they play: Bus 1, Bus 2, or dry into Bus 3. A pad lights in the colour of the bus it plays into.
- **Rec** (key T): resamples what you hear into the selected empty pad (or the next empty one). It records 1, 2 or 4 bars starting on the next bar, or runs until you stop it (up to 60 seconds). Recordings know their BPM and can follow tempo changes. For a loaded sample, type its BPM in the pad's BPM box to let it follow too.
- **Banks** (key B): two banks of 12 pads, A1–A12 and B1–B12.
- **Selecting pads**: Shift+click selects a pad without playing it. Ctrl+click (Cmd+click on a Mac) adds or removes pads without playing them. With several selected, mode, Follow BPM, BPM, choke group and level apply to all of them, a field shows Mixed where they differ, and Clear empties every selected pad. Click a tag in the pad panel to take that pad out, or click any pad to go back to it alone.
- **Moving pads**: drag a pad onto another pad, then choose Move, Copy or Cancel (plus Swap if the target already holds a sample). The sample goes with its trim, chops, BPM and pad settings, and Move leaves the source pad empty. Hold Shift while you drag so the pad doesn't play. A plain drag stops the pad once the drag starts. To reach the other bank, hover the A/B switch for half a second, or press B while dragging. Esc cancels.
- **Choke groups**: put pads in the same group (1–4) and starting one cuts off any other pad in that group, like an open and closed hi-hat. A quantized loop cuts the others on the beat it starts. The group shows on the pad as G1–G4.
- **Pad tools**: load an audio file (or drop one onto a pad; the first 60 seconds are kept), export a pad as a 16-bit WAV, or clear it (click twice). Pads are kept between sessions.
- **Edit / chop**: a waveform editor for the selected pad.
  - Drag **S** and **E** to trim. This doesn't change the audio, Reset trim brings back the whole sample, and it's saved as you go. **Truncate** (click twice) cuts the sample down to S–E for good, keeping the pad's settings and chops.
  - Add chops with Split evenly (2–16), Find hits (drum hits and note starts), a double-click, or by tapping **G** in time while it plays. The playhead follows the pad too, so you can play the pad in its own mode (Loop, Gate or One-shot) and chop along with it.
  - Shift+scroll zooms in and out around the mouse, and Alt+scroll zooms the amplitude so quiet parts are easier to chop. While zoomed in, hold the scroll wheel down and drag the waveform to move along it, or drag the bar under it (or scroll sideways on a trackpad). Shift+double-click resets the time zoom and Alt+double-click resets the amplitude. Shift and Alt clicks don't play or add chops.
  - Click a slice to hear it. Drag a chop line to move it and double-click it to remove it. Chops and trim points snap to the nearest zero crossing so slices start and end without a click. Turn off **Snap to zero crossings** to place them exactly.
  - **Send slices to pads** puts each slice on its own empty pad (the ones after the source, wrapping round to the start) as a One-shot with tiny fades at each edge.
- **Sources**: each captured tab gets a level fader, a mute button, a route (Bus 1, Bus 2, or dry into Bus 3) and an In FX switch that sends it through Input FX first. Put sources on side A or B to mix them with the crossfader.

**Edit** is the full chain editor: up to 8 effects per bus in any order, every parameter, a menu on each effect to swap it in place, an LFO per effect with its own on/off switch, and an on/off switch per bus. Input FX has its own route, and Master FX holds the master volume.

### Effects

| Group | Effects |
|---|---|
| Filter | Filter + Drive, Isolator, Super Filter, Equalizer |
| Character | Vinyl Sim, Cassette Sim, Lo-Fi, Bit Crusher, Compressor, Limiter |
| Space | Delay, Tape Echo, Reverb, Chorus, Flanger, Phaser |
| Glitch | Scatter, Stopper, DJ Looper, Slicer, Downer |
| Granular | Grain Cloud, Resonator |
| Input | Auto Pitch, Vocoder, Amp Sim (Input FX only) |

Input FX takes Filter + Drive, Isolator, Equalizer, Compressor, Limiter, Delay, Reverb and Chorus, plus the Input group. Every other effect is for Buses 1–4 and Master FX. Delay, Tape Echo, the LFOs and the glitch effects can sync to the tempo.

**Presets**: pick one from the menu next to Perform/Edit to load it. The built-in ones are Init (all off), Classic 404 chain (Lo-Fi, Vinyl Sim and Compressor on Bus 4 with a Limiter on Master) and Glitch kit (hold 1, 2 or 3 for DJ Looper, Stopper or Scatter), plus a Filter smoke test. **Save** stores the current FX setup under a name: each bus's effects, their settings and LFOs, which buses are on, and the bus routing. Saving under a name you already used replaces that preset. Your presets appear under Saved in the menu and as tags in the save box, where × deletes one (click twice). Pads and tempo aren't part of a preset.

**Bus routing** (top of Edit): **Parallel** is the SP-404 layout, where Bus 1 and Bus 2 each feed Bus 3, then Bus 4. **Series** chains them, Bus 1 → Bus 2 → Bus 3 → Bus 4, so a source sent to Bus 1 runs through every bus and one sent to Bus 2 skips Bus 1.

### Timing

- **BPM**: type a tempo (40–240), or use ½ and ×2 to halve or double it.
- **Tap** (Space): your first tap marks beat 1 of the bar, and later taps set the tempo.
- **Auto**: follows the tempo it hears and locks the beat grid to the detected beats. The screen shows the tempo it hears and how sure it is, even with Auto off.
- **Q** (quantize): sets the grid that glitch effects (Scatter, Stopper, DJ Looper, Slicer, Downer) and loops start on. Glitch patterns always follow the grid, so a Slicer pattern lines up with the bar even when quantize is off.

### Keys and MIDI

Keys 1–6 are the bus FX buttons. The pads are the 4×3 block Q W E R / A S D F / Z X C V, matching the pad grid. T records, G chops at the playhead while editing, and B switches bank, so the column next to the pads holds the functions. Space is tap and Esc stops all pads. They work while the panel has focus, except while you're typing in a box (tempo, pad BPM or preset name) or the Move/Copy popup is open. Space activates a button only if you reached that button with Tab.

**MIDI learn**: click a CTRL knob, an Edit slider, a bus button or a pad, then move a knob or hit a pad on your controller. Notes (or CC ≥ 64) press bus buttons and pads. A CTRL knob mapping follows whichever effect is selected.

## Layout

| Path | What |
|---|---|
| `background/` | Persistent background page: hosts the `AudioContext` and engine, captures tabs, routes messages, stores settings and pads |
| `capture/` | Content script that takes a tab's audio and streams it to the engine, and its tap worklet |
| `engine/` | `AudioEngine`, buses, slots, pads, tempo detection, recorder |
| `effects/` | Effect definitions, `registry.js` (CTRL knobs, quantized effects), AudioWorklets |
| `shared/` | State shape, messages, beat grid, params, LFO, tempo and hit detection, chopping, WAV, pad storage |
| `sidepanel/` | UI: `perform.js` (Perform view), `editor.js` (chop editor), `presets.js` (saved presets), `sidepanel.js` (shell + Edit view), keys, MIDI |
| `tests/` | Offline audio suites and the end-to-end extension suite |

## Tests

The audio suites render the engine offline in a browser and check the output signal:

```sh
PUPPETEER=<path to puppeteer-core> FIREFOX=<path to firefox.exe> node tests/run-headless.cjs
```

This runs `filter-smoke`, `tempo-smoke`, `fx-smoke` and `perform-smoke`. Pass suite names to run a subset.

The end-to-end suite installs the add-on in headless Firefox through Selenium and geckodriver (Selenium fetches geckodriver itself), drives the sidebar page and captures a local test page. Test audio goes to your sound device with Firefox's output volume at zero, and the test tone is very quiet:

```sh
SELENIUM=<path to selenium-webdriver> FIREFOX=<path to firefox.exe> node tests/run-extension.cjs [screenshot-dir]
```

## License

[MIT](LICENSE)
