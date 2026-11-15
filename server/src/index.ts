import "./env.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3000);
createApp().listen(port, process.env.DYSPHAGRIP_LOCAL_DASHBOARD === "1" ? "127.0.0.1" : "0.0.0.0", () => console.log(`DysphaGrip API listening on ${port}`));
