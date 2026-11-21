import { createRoot } from "react-dom/client";
import { PanelApp } from "../PanelApp";
import "../styles/global.css";
import "../styles/app.css";

createRoot(document.getElementById("root")!).render(<PanelApp />);
