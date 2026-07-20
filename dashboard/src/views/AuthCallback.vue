<template>
  <q-page class="flex flex-center">
    <div class="column items-center q-gutter-sm">
      <q-spinner size="40px" color="primary" />
      <div class="text-grey-6">Signing you in…</div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
// supabase-js auto-parses the ?code=... the OAuth provider redirected here
// with (detectSessionInUrl, on by default) as part of its own client
// initialization — getSession() below awaits that same initialization
// before returning, so it's enough to just wait for it and move on.
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { supabase } from "../lib/supabaseClient";

const router = useRouter();

onMounted(async () => {
  if (supabase) await supabase.auth.getSession();
  router.replace("/account");
});
</script>
