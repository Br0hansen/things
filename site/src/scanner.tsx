import { useEffect, useRef, useState } from "preact/hooks";
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { hasValidCheckDigit, normalizeEan } from "./lib/domain";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"] as const;
/** Short pause between reads so the sheet stays responsive. */
const SCAN_GAP_MS = 30;
/** The middle band of the frame is read, scaled down to at most this width. */
const MAX_CROP_WIDTH = 1280;
const BAND_RATIO = 0.6;
const TARGET_ZOOM = 2;

interface Detector {
  detect(source: HTMLCanvasElement): Promise<Array<{ rawValue: string }>>;
}

interface NativeDetectorClass {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
}

/** Native BarcodeDetector where it reads EAN-13, otherwise the zxing-wasm ponyfill (e.g. iPhone Safari). */
async function createDetector(): Promise<Detector> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats();
      if (supported.includes("ean_13")) return new Native({ formats: FORMATS.filter((format) => supported.includes(format)) });
    } catch { /* Fall back to the ponyfill. */ }
  }
  const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/ponyfill");
  // Serve the .wasm from our own origin instead of the package's default CDN.
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => path.endsWith(".wasm") ? zxingWasmUrl : prefix + path } });
  return new BarcodeDetector({ formats: [...FORMATS] });
}

/**
 * Continuous focus and 2x zoom where the browser allows it. Zoom lets the phone be held
 * further away, past the close-focus limit of the main camera on many phones.
 */
async function tuneCamera(track: MediaStreamTrack) {
  const capabilities = (track.getCapabilities?.() ?? {}) as { focusMode?: string[]; zoom?: { min?: number; max?: number } };
  const settings: Record<string, unknown> = {};
  if (capabilities.focusMode?.includes("continuous")) settings.focusMode = "continuous";
  if (capabilities.zoom?.max && capabilities.zoom.max >= TARGET_ZOOM) settings.zoom = Math.max(capabilities.zoom.min ?? 1, TARGET_ZOOM);
  if (Object.keys(settings).length > 0) await track.applyConstraints({ advanced: [settings as MediaTrackConstraintSet] }).catch(() => undefined);
}

/** Copies the middle band of the frame, where the guide is, at full detail. */
function cropBand(video: HTMLVideoElement, canvas: HTMLCanvasElement): HTMLCanvasElement {
  const width = video.videoWidth;
  const bandHeight = Math.min(video.videoHeight, Math.round(width * BAND_RATIO));
  const scale = Math.min(1, MAX_CROP_WIDTH / width);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(bandHeight * scale);
  canvas.getContext("2d", { willReadFrequently: true })?.drawImage(video, 0, Math.round((video.videoHeight - bandHeight) / 2), width, bandHeight, 0, 0, canvas.width, canvas.height);
  return canvas;
}

type ScannerState = "starting" | "scanning" | "denied" | "unavailable" | "unsupported";

const STATE_COPY: Record<Exclude<ScannerState, "scanning">, string> = {
  starting: "Starter kameraet …",
  denied: "Things får ikke bruke kameraet. Gi tilgang i nettleserens innstillinger og prøv igjen.",
  unavailable: "Fant ikke noe kamera som kan brukes.",
  unsupported: "Skanning virker ikke i denne nettleseren.",
};

export function Scanner({ onDetected }: { onDetected(ean: string): void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScannerState>("starting");

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setState("unavailable"); return; }
      const detectorPromise = createDetector();
      detectorPromise.catch(() => undefined);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch (cause) {
        if (!stopped) setState(cause instanceof DOMException && cause.name === "NotAllowedError" ? "denied" : "unavailable");
        return;
      }
      const video = videoRef.current;
      if (stopped || !video) { stop(); return; }
      const [track] = stream.getVideoTracks();
      if (track) await tuneCamera(track);
      video.srcObject = stream;
      await video.play().catch(() => undefined);

      let detector: Detector;
      try { detector = await detectorPromise; }
      catch { if (!stopped) setState("unsupported"); stop(); return; }
      if (stopped) return;
      setState("scanning");

      // A valid check digit is enough. Codes without one (UPC-E) must be read twice in a row.
      const canvas = document.createElement("canvas");
      let previous = "";
      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
          try {
            const codes = await detector.detect(cropBand(video, canvas));
            const ean = codes.map((code) => normalizeEan(code.rawValue)).find((value): value is string => Boolean(value));
            if (ean && (hasValidCheckDigit(ean) || ean === previous) && !stopped) {
              stop(); navigator.vibrate?.(20); onDetected(ean);
              return;
            }
            if (ean) previous = ean;
          } catch { /* One bad frame is fine; keep scanning. */ }
        }
        if (!stopped) timer = window.setTimeout(() => void tick(), SCAN_GAP_MS);
      };
      void tick();
    })();

    return stop;
  }, []);

  return <div class="scanner">
    <div class={`scanner-view ${state === "scanning" ? "active" : ""}`} hidden={state !== "starting" && state !== "scanning"}>
      <video ref={videoRef} playsInline muted autoPlay />
      {state === "scanning" && <div class="scanner-guide" aria-hidden="true" />}
    </div>
    <p class="scanner-message" role="status">{state === "scanning" ? "Hold strekkoden inne i rammen, litt unna kameraet." : STATE_COPY[state]}</p>
  </div>;
}
