import "./env.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3000);
const localMode = process.env.DYSPHAGRIP_PUBLIC !== "1" && process.env.DYSPHAGRIP_LOCAL_DASHBOARD === "1";
createApp().listen(port, localMode ? "127.0.0.1" : "0.0.0.0", () => console.log(`DysphaGrip API listening on ${port}`));
