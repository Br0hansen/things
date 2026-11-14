import { render } from "preact";
import { App } from "./app";
import "./styles.css";

render(<App />, document.getElementById("app")!);

// iOS Safari ignores user-scalable=no, so block pinch-zoom explicitly.
document.addEventListener("gesturestart", (event) => event.preventDefault());

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`));
}

