import { createApp } from "vue";
import { Quasar, Notify } from "quasar";
import "@quasar/extras/material-icons/material-icons.css";
import "quasar/src/css/index.sass";
// Dark theme + purple accent + custom panel/row/chat-bubble classes, modeled
// on the BotBuzz Figma reference — see the file itself for the full rationale.
import "./styles/theme.css";

import App from "./App.vue";
import router from "./router";

const app = createApp(App);

app.use(Quasar, { plugins: { Notify }, config: { dark: true } });
app.use(router);

app.mount("#app");
