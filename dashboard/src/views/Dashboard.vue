<template>
  <q-page class="q-pa-md">
    <div class="row items-center justify-end q-mb-sm">
      <q-select
        v-model="selectedCompanyId"
        dense
        outlined
        emit-value
        map-options
        clearable
        options-dense
        style="min-width: 200px"
        :options="companyOptions"
      >
        <!-- See MeetingsCalendarPanel.vue's identical #selected slot comment
             — an explicit slot avoids relying on the `placeholder` prop's
             CSS-only rendering, which doesn't reserve visible width here. -->
        <template #selected>
          {{ selectedCompanyLabel }}
        </template>
      </q-select>
    </div>

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-12 col-sm-6 col-md-3">
        <StatTile label="Needs Approval" :value="needsApprovalCount" sublabel="meetings awaiting review" />
      </div>
      <div class="col-12 col-sm-6 col-md-3">
        <StatTile
          label="Action Items This Week"
          :value="actionItemsThisWeek.total"
          :sublabel="`${actionItemsThisWeek.open} open · ${actionItemsThisWeek.done} done`"
        />
      </div>
      <div class="col-12 col-sm-6 col-md-3">
        <StatTile
          label="Follow-ups This Week"
          :value="followUpsThisWeek.total"
          :sublabel="`${followUpsThisWeek.open} open · ${followUpsThisWeek.done} done`"
        />
      </div>
      <div class="col-12 col-sm-6 col-md-3">
        <StatTile label="Overdue" :value="overdueCount" sublabel="open items past 3 days" />
      </div>
    </div>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <div class="bw-panel">
          <div class="bw-panel__header">
            <div class="bw-panel__title">Top Follow-ups This Week</div>
            <div class="bw-panel__subtitle">Most urgent open follow-ups from this week's meetings</div>
          </div>
          <div class="bw-panel__body">
            <router-link
              v-for="f in topFollowUpsThisWeek"
              :key="`${f.meetingId}-${f.index}`"
              :to="`/meetings/${f.meetingId}`"
              class="bw-row"
            >
              <div class="row items-center no-wrap">
                <div class="col">
                  <div class="bw-row__title">{{ f.text }}</div>
                  <div class="bw-row__meta">
                    <span v-if="f.person">with <PersonTag :name="f.person" /> · </span>{{ f.meetingTopic }}
                  </div>
                </div>
                <span class="bw-pill" :class="urgencyPillClass(f.urgency)">{{ urgencyLabel(f.urgency) }}</span>
              </div>
            </router-link>
            <div v-if="!topFollowUpsThisWeek.length && !loading" class="text-grey-7 q-pa-md text-center">
              Nothing outstanding this week.
            </div>
          </div>
        </div>
      </div>

      <div class="col-12 col-md-6">
        <div class="bw-panel">
          <div class="bw-panel__header">
            <div class="bw-panel__title">Meetings Needing Approval</div>
            <div class="bw-panel__subtitle">Processed meetings you haven't fully reviewed yet</div>
          </div>
          <div class="bw-panel__body">
            <router-link v-for="m in meetingsNeedingApproval" :key="m.id" :to="`/meetings/${m.id}`" class="bw-row">
              <div class="bw-row__title">{{ m.topic }}</div>
              <div class="bw-row__meta">{{ formatDate(m.startTime) }}</div>
            </router-link>
            <div v-if="!meetingsNeedingApproval.length && !loading" class="text-grey-7 q-pa-md text-center">
              Nothing waiting on you.
            </div>
          </div>
        </div>
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useDashboardStats } from "../composables/useDashboardStats";
import { fetchCompanies, type Company } from "../api";
import { useAsyncList } from "../composables/useAsyncList";
import { urgencyLabel, urgencyPillClass } from "../urgency";
import { formatMeetingDateTime as formatDate } from "../formatDate";
import PersonTag from "../components/PersonTag.vue";
import StatTile from "../components/StatTile.vue";

// Company filter (added 2026-07-17) — scopes every stat/list on this page to
// one portfolio company at a glance.
const { data: companies } = useAsyncList(async () => (await fetchCompanies()).companies, [] as Company[]);
const selectedCompanyId = ref<string | null>(null);
const companyOptions = computed(() => companies.value.map((c) => ({ label: c.name, value: c.id })));
const selectedCompanyLabel = computed(
  () => companies.value.find((c) => c.id === selectedCompanyId.value)?.name ?? "All companies"
);

const {
  loading,
  needsApprovalCount,
  actionItemsThisWeek,
  followUpsThisWeek,
  overdueCount,
  topFollowUpsThisWeek,
  meetingsNeedingApproval,
} = useDashboardStats(selectedCompanyId);
</script>
