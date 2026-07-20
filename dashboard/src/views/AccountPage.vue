<template>
  <q-page padding style="max-width: 700px; margin: 0 auto">
    <div class="bw-panel q-pa-lg">
      <div class="bw-panel__title q-mb-xs">Account</div>
      <div class="bw-panel__subtitle q-mb-md">
        Connect your Zoom and Asana accounts, set up your local transcript watch folder, and
        (if you're an admin) manage the team — all from here, any time.
      </div>

      <q-banner v-if="!appUser && !authInitializing" class="bg-red-1 text-red-9 q-mb-md" rounded>
        Couldn't resolve your account — you may not be invited yet. Ask an admin to add you.
      </q-banner>

      <template v-else>
        <q-banner v-if="connectBanner" :class="connectBanner.class" class="q-mb-md" rounded>
          {{ connectBanner.text }}
        </q-banner>

        <q-tabs v-model="tab" dense class="text-grey-6" active-color="white" indicator-color="primary" align="left">
          <q-tab name="integrations" label="Integrations" />
          <q-tab name="local-setup" label="Local Setup" />
          <q-tab v-if="isAdmin" name="team" label="Team" />
        </q-tabs>
        <q-separator class="q-mb-md" />

        <q-tab-panels v-model="tab" animated class="bg-transparent">
          <!-- Integrations ------------------------------------------------------ -->
          <q-tab-panel name="integrations" class="q-px-none">
            <q-banner v-if="connectionsError" class="bg-red-1 text-red-9 q-mb-md" rounded>{{ connectionsError }}</q-banner>
            <div class="column q-gutter-sm">
              <IntegrationConnectCard
                provider="zoom"
                :connection="connectionByProvider.zoom"
                :loading="connectAction.activeKey.value === 'zoom' || disconnectAction.activeKey.value === 'zoom'"
                @connect="connect('zoom')"
                @disconnect="disconnectProvider('zoom')"
              />
              <IntegrationConnectCard
                provider="asana"
                :connection="connectionByProvider.asana"
                :loading="connectAction.activeKey.value === 'asana' || disconnectAction.activeKey.value === 'asana'"
                @connect="connect('asana')"
                @disconnect="disconnectProvider('asana')"
              />
            </div>
            <q-inner-loading :showing="connectionsLoading" />
          </q-tab-panel>

          <!-- Local Setup -------------------------------------------------------- -->
          <q-tab-panel name="local-setup" class="q-px-none">
            <div class="text-grey-6 q-mb-md">
              Good Wrap watches a folder on your Mac for dropped-in transcripts. The setup script below picks
              your folder with a native dialog and installs everything else automatically — you'll still need
              <a href="https://docs.claude.com/en/docs/claude-code/overview" target="_blank" rel="noopener" class="text-primary">Claude Code</a>
              installed and logged in once first, and your local <code>good-wrap</code> checkout on hand.
            </div>

            <q-banner v-if="setupScriptError" class="bg-red-1 text-red-9 q-mb-md" rounded>{{ setupScriptError }}</q-banner>
            <q-banner v-if="setupScriptDownloaded" class="bg-green-1 text-green-9 q-mb-md" rounded>
              Downloaded <strong>goodwrap-setup.command</strong> — double-click it in Finder (or run it from
              Terminal) to finish setup. Re-run this any time to pick a new folder or reinstall the job.
            </q-banner>

            <q-btn
              unelevated
              color="primary"
              no-caps
              label="Generate setup script"
              :loading="generatingSetupScript"
              @click="downloadSetupScript"
            />

            <q-separator class="q-my-md" />

            <div class="text-weight-medium q-mb-sm">Your worker keys</div>
            <q-banner v-if="workerKeysError" class="bg-red-1 text-red-9 q-mb-md" rounded>{{ workerKeysError }}</q-banner>
            <div v-if="!workerKeys.length && !workerKeysLoading" class="text-grey-7 text-caption">
              None yet — generating a setup script above creates one automatically.
            </div>
            <div v-for="key in workerKeys" :key="key.id" class="bw-row row items-center q-gutter-sm no-wrap">
              <div class="col">
                <div class="text-weight-medium">{{ key.label ?? "Untitled key" }}</div>
                <div class="text-caption text-grey-6">
                  {{ key.keyPrefix }}… · created {{ formatDate(key.createdAt) }}
                  <template v-if="key.lastUsedAt"> · last used {{ formatDate(key.lastUsedAt) }}</template>
                </div>
              </div>
              <q-btn
                flat
                dense
                no-caps
                color="negative"
                label="Revoke"
                :loading="revokeAction.activeKey.value === key.id"
                @click="revoke(key.id)"
              />
            </div>
            <q-inner-loading :showing="workerKeysLoading" />
          </q-tab-panel>

          <!-- Team (admin-only) --------------------------------------------------- -->
          <q-tab-panel v-if="isAdmin" name="team" class="q-px-none">
            <div class="text-weight-medium q-mb-sm">Invite a teammate</div>
            <q-banner v-if="inviteError" class="bg-red-1 text-red-9 q-mb-md" rounded>{{ inviteError }}</q-banner>
            <div class="row q-gutter-sm q-mb-lg items-start">
              <q-input v-model="inviteName" dense filled label="Name" class="col" />
              <q-input v-model="inviteEmail" dense filled label="Email" class="col" />
              <q-btn unelevated color="primary" no-caps label="Invite" :loading="inviting" @click="invite" />
            </div>

            <div class="text-weight-medium q-mb-sm">Everyone</div>
            <q-banner v-if="usersError" class="bg-red-1 text-red-9 q-mb-md" rounded>{{ usersError }}</q-banner>
            <div v-for="user in users" :key="user.id" class="bw-row row items-center q-gutter-sm no-wrap">
              <div class="col">
                <div class="text-weight-medium">
                  {{ user.name }}
                  <q-badge v-if="user.role === 'admin'" color="primary" class="q-ml-xs">admin</q-badge>
                  <q-badge v-if="user.disabledAt" color="grey-8" class="q-ml-xs">disabled</q-badge>
                </div>
                <div class="text-caption text-grey-6">{{ user.email }}</div>
              </div>
              <q-btn
                flat
                dense
                no-caps
                :label="user.disabledAt ? 'Re-enable' : 'Disable'"
                :loading="disableAction.activeKey.value === user.id"
                @click="toggleDisabled(user)"
              />
            </div>
            <q-inner-loading :showing="usersLoading" />
          </q-tab-panel>
        </q-tab-panels>
      </template>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useAsyncList } from "../composables/useAsyncList";
import { useKeyedAsyncAction } from "../composables/useKeyedAsyncAction";
import IntegrationConnectCard from "../components/IntegrationConnectCard.vue";
import {
  fetchIntegrations,
  getIntegrationAuthorizeUrl,
  disconnectIntegration,
  fetchWorkerKeys,
  revokeWorkerKey,
  generateSetupScript,
  fetchAdminUsers,
  inviteUser,
  setUserDisabled,
  type IntegrationProviderName,
  type AdminUser,
} from "../api";

const route = useRoute();
const router = useRouter();
const { appUser, initializing: authInitializing } = useAuth();
const isAdmin = computed(() => appUser.value?.role === "admin");

const tab = ref("integrations");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Query params from the OAuth callback redirect (see routes/integrations.ts).
const connectBanner = computed(() => {
  const connected = route.query.connected;
  const connectError = route.query.connectError;
  if (typeof connected === "string") {
    return { class: "bg-green-1 text-green-9", text: `Connected ${connected === "zoom" ? "Zoom" : "Asana"}.` };
  }
  if (typeof connectError === "string") {
    return { class: "bg-red-1 text-red-9", text: `Couldn't connect ${connectError === "zoom" ? "Zoom" : "Asana"} — try again.` };
  }
  return null;
});

// --- Integrations ------------------------------------------------------------------

const {
  data: connections,
  loading: connectionsLoading,
  error: connectionsError,
  refetch: refetchConnections,
} = useAsyncList(async () => (await fetchIntegrations()).connections, []);

const connectionByProvider = computed(() => ({
  zoom: connections.value.find((c) => c.provider === "zoom"),
  asana: connections.value.find((c) => c.provider === "asana"),
}));

const connectAction = useKeyedAsyncAction(connectionsError, () => {});
async function connect(provider: IntegrationProviderName) {
  await connectAction.run(provider, async () => {
    const { authorizeUrl } = await getIntegrationAuthorizeUrl(provider);
    window.location.href = authorizeUrl;
  });
}

const disconnectAction = useKeyedAsyncAction(connectionsError, refetchConnections);
async function disconnectProvider(provider: IntegrationProviderName) {
  await disconnectAction.run(provider, async () => {
    await disconnectIntegration(provider);
  });
}

// Clear the ?connected=/?connectError= query params once shown, and refresh
// connection status — the redirect landed here right after a real change.
if (connectBanner.value) {
  void refetchConnections();
  router.replace({ path: "/account" });
}

// --- Local Setup ---------------------------------------------------------------

const {
  data: workerKeys,
  loading: workerKeysLoading,
  error: workerKeysError,
  refetch: refetchWorkerKeys,
} = useAsyncList(async () => (await fetchWorkerKeys()).workerKeys, []);

const revokeAction = useKeyedAsyncAction(workerKeysError, refetchWorkerKeys);
async function revoke(id: string) {
  await revokeAction.run(id, async () => {
    await revokeWorkerKey(id);
  });
}

const generatingSetupScript = ref(false);
const setupScriptError = ref("");
const setupScriptDownloaded = ref(false);

async function downloadSetupScript() {
  generatingSetupScript.value = true;
  setupScriptError.value = "";
  setupScriptDownloaded.value = false;
  try {
    const { filename, contents } = await generateSetupScript();
    const blob = new Blob([contents], { type: "text/x-shellscript" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setupScriptDownloaded.value = true;
    void refetchWorkerKeys();
  } catch (err) {
    setupScriptError.value = err instanceof Error ? err.message : String(err);
  } finally {
    generatingSetupScript.value = false;
  }
}

// --- Team (admin-only) --------------------------------------------------------

const {
  data: users,
  loading: usersLoading,
  error: usersError,
  refetch: refetchUsers,
} = useAsyncList(async () => (isAdmin.value ? (await fetchAdminUsers()).users : []), [] as AdminUser[]);

// appUser (and therefore isAdmin) resolves asynchronously after mount (see
// useAuth) — the initial useAsyncList fetch above may run before that
// resolves, so re-fetch once isAdmin actually flips true instead of only
// ever checking it at mount time.
watch(isAdmin, (nowAdmin) => {
  if (nowAdmin) void refetchUsers();
});

const inviteName = ref("");
const inviteEmail = ref("");
const inviting = ref(false);
const inviteError = ref("");

async function invite() {
  if (!inviteName.value.trim() || !inviteEmail.value.trim()) return;
  inviting.value = true;
  inviteError.value = "";
  try {
    await inviteUser({ name: inviteName.value.trim(), email: inviteEmail.value.trim() });
    inviteName.value = "";
    inviteEmail.value = "";
    await refetchUsers();
  } catch (err) {
    inviteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    inviting.value = false;
  }
}

const disableAction = useKeyedAsyncAction(usersError, refetchUsers);
async function toggleDisabled(user: AdminUser) {
  await disableAction.run(user.id, async () => {
    await setUserDisabled(user.id, !user.disabledAt);
  });
}
</script>
