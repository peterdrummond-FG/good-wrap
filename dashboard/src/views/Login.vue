<template>
  <q-page class="flex flex-center">
    <div class="bw-panel q-pa-lg" style="width: 340px">
      <div class="row items-center q-gutter-sm q-mb-md">
        <div
          class="flex flex-center"
          style="width: 32px; height: 32px; border-radius: 9px; background: var(--q-primary)"
        >
          <q-icon name="smart_toy" color="white" size="18px" />
        </div>
        <div class="text-weight-bold text-white text-h6">good-wrap</div>
      </div>

      <div class="text-grey-6 q-mb-lg">Sign in with your Flippen Group account.</div>

      <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
        {{ error }}
      </q-banner>

      <div class="column q-gutter-sm">
        <q-btn
          unelevated
          color="white"
          text-color="dark"
          label="Continue with Google"
          :loading="pending === 'google'"
          @click="signIn('google')"
        />
        <q-btn
          unelevated
          color="white"
          text-color="dark"
          label="Continue with Microsoft"
          :loading="pending === 'microsoft'"
          @click="signIn('microsoft')"
        />
      </div>

      <div class="text-caption text-grey-7 q-mt-lg">
        Not on the team yet? Ask an admin to add you first — sign-in only works for invited emails.
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useAuth } from "../composables/useAuth";

const { signInWithGoogle, signInWithMicrosoft } = useAuth();
const pending = ref<"google" | "microsoft" | null>(null);
const error = ref("");

async function signIn(provider: "google" | "microsoft") {
  pending.value = provider;
  error.value = "";
  try {
    const { error: authError } = await (provider === "google" ? signInWithGoogle() : signInWithMicrosoft());
    if (authError) throw authError;
    // On success the browser navigates away to the provider immediately —
    // pending.value is left true intentionally so the button stays in its
    // loading state until that navigation actually happens.
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    pending.value = null;
  }
}
</script>
