import { useEffect, useRef, useState } from "preact/hooks";
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { normalizeEan } from "./lib/domain";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"] as const;
const SCAN_INTERVAL_MS = 150;

interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
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
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (cause) {
        if (!stopped) setState(cause instanceof DOMException && cause.name === "NotAllowedError" ? "denied" : "unavailable");
        return;
      }
      const video = videoRef.current;
      if (stopped || !video) { stop(); return; }
      video.srcObject = stream;
      await video.play().catch(() => undefined);

      let detector: Detector;
      try { detector = await detectorPromise; }
      catch { if (!stopped) setState("unsupported"); stop(); return; }
      if (stopped) return;
      setState("scanning");

      // Require the same code in two reads in a row to avoid misreads.
      let previous = "";
      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          try {
            const codes = await detector.detect(video);
            const ean = codes.map((code) => normalizeEan(code.rawValue)).find((value): value is string => Boolean(value));
            if (ean && ean === previous && !stopped) {
              stop(); navigator.vibrate?.(20); onDetected(ean);
              return;
            }
            if (ean) previous = ean;
          } catch { /* One bad frame is fine; keep scanning. */ }
        }
        if (!stopped) timer = window.setTimeout(() => void tick(), SCAN_INTERVAL_MS);
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
    <p class="scanner-message" role="status">{state === "scanning" ? "Hold strekkoden inne i rammen." : STATE_COPY[state]}</p>
  </div>;
}
