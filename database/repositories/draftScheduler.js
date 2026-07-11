import { getDraftEventPostgres } from './draftEventStore.js';
import { transitionWutDraftEventPostgres } from './draftEvents.js';
import { forceWutDraftAutopickPostgres } from './draftGameplay.js';
import { finishWutDraftDeckbuildingPostgres, timeoutWutDraftEventMatchPostgres } from './draftTournament.js';

export async function processWutDraftEventsPostgres(pool, now = new Date()) {
  const ids = (await pool.query(`SELECT id FROM draft_events WHERE phase NOT IN ('cancelled','prizes_awarded') ORDER BY id`)).rows.map(row => Number(row.id));
  const changed = []; const startDue = [];
  for (const id of ids) {
    let event = await getDraftEventPostgres(pool, id); if (event.paused_at) continue;
    const opens = event.config?.scheduling?.signupOpensAt ? new Date(event.config.scheduling.signupOpensAt) : null;
    const closes = event.config?.scheduling?.signupClosesAt ? new Date(event.config.scheduling.signupClosesAt) : null;
    const starts = event.config?.scheduling?.startsAt ? new Date(event.config.scheduling.startsAt) : null;
    if (event.phase === 'scheduled' && opens && now >= opens) {
      event = await transitionWutDraftEventPostgres(pool, { eventId: id, nextPhase: 'signup_open', system: true, reason: 'Scheduled signup opening', now }); changed.push(id);
    }
    if (event.phase === 'signup_open' && ((event.config.signup.automaticClose && closes && now >= closes) || (event.config.basic.automaticStart && starts && now >= starts))) {
      event = await transitionWutDraftEventPostgres(pool, { eventId: id, nextPhase: 'signup_closed', system: true, reason: 'Scheduled signup closing', now }); changed.push(id);
    }
    if (event.phase === 'signup_closed' && event.config.basic.automaticStart && starts && now >= starts &&
      event.entrants.filter(item => item.status === 'active').length >= Number(event.config.basic.minimumEntrants)) startDue.push(id);
    if (event.phase === 'draft' && event.draft?.deadline_at && event.config.draft.autopick.enabled && now >= new Date(event.draft.deadline_at)) {
      await forceWutDraftAutopickPostgres(pool, { eventId: id, system: true, now }); changed.push(id); continue;
    }
    if (event.phase === 'deckbuilding' && event.deckbuilding?.deadline_at && !event.deckbuilding.completed_at && now >= new Date(event.deckbuilding.deadline_at)) {
      await finishWutDraftDeckbuildingPostgres(pool, { eventId: id, autosubmitMissing: true, now }); changed.push(id); continue;
    }
    if (event.phase === 'tournament') for (const match of event.tournament.matches || []) {
      if (match.status === 'active' && match.turn_deadline && now >= new Date(match.turn_deadline)) {
        await timeoutWutDraftEventMatchPostgres(pool, { eventId: id, matchId: match.id, now }); changed.push(id); break;
      }
    }
  }
  return { changedEventIds: [...new Set(changed)], startDueEventIds: startDue };
}
