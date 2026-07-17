import { createRouter, createWebHistory } from "vue-router";
import Dashboard from "../views/Dashboard.vue";
import MeetingsView from "../views/MeetingsView.vue";
import CaptureForm from "../views/CaptureForm.vue";
import AskPage from "../views/AskPage.vue";
import PeopleList from "../views/PeopleList.vue";
import PersonDetail from "../views/PersonDetail.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: Dashboard },
    // Optional :id — "/meetings" (nav link, no selection) and "/meetings/:id"
    // (deep link from Capture/Ask/Person Detail) are the same calendar-day
    // screen; the id just pre-selects a meeting and jumps to its day.
    { path: "/meetings/:id?", name: "meetings", component: MeetingsView, props: true },
    { path: "/capture", name: "capture", component: CaptureForm },
    { path: "/ask", name: "ask", component: AskPage },
    { path: "/people", name: "people", component: PeopleList },
    { path: "/people/:id", name: "person-detail", component: PersonDetail, props: true },
  ],
});

export default router;
