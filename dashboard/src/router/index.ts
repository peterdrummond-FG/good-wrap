import { createRouter, createWebHistory } from "vue-router";
import Dashboard from "../views/Dashboard.vue";
import MeetingDetail from "../views/MeetingDetail.vue";
import CaptureForm from "../views/CaptureForm.vue";
import AskPage from "../views/AskPage.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: Dashboard },
    { path: "/meetings/:id", name: "meeting-detail", component: MeetingDetail, props: true },
    { path: "/capture", name: "capture", component: CaptureForm },
    { path: "/ask", name: "ask", component: AskPage },
  ],
});

export default router;
