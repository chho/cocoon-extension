import "./popup.css";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Popup root element was not found.");
}

const heading = document.createElement("h1");
heading.textContent = "Hello";
app.append(heading);
