// Date reminders: once every morning (after 8:00 AM business time) the server looks at each tracker's reminders and
// adds a bell notification for every row and person due one today. No AI. The notification's key holds the day, so
// a restart, a second server or a second check the same day never sends a reminder twice.
//
// Snoozes are kept with the tracker's history records (kind "snooze"): no new table.
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import rateLimit from 'express-rate-limit'
import { cleanTimelineSettings } from '../../src/features/trackers/timelineModel'
import { TrackerError } from '../../src/features/trackers/trackerModel'
import { makeLookup } from '../../src/features/trackers/trackerQuery'
import {
  businessHour,
  reminderDue,
  reminderHourReached,
  reminderKey,
  reminderPeople,
  reminderText,
} from '../../src/features/trackers/trackerReminders'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import type { Deps, User } from './tracker-common'
import type { TrackerCore } from './tracker-core'

const SNOOZE = 'snooze'
const NOTIFICATIONS_KEPT = 500

export function trackerReminders(
  deps: Deps,
  core: TrackerCore,
  allRows: (tenant: string, trackerId: string) => Promise<any[]>,
  timeZone: string,
) {
  const { db, check, columnsOf, rowOut, trackerVisibleIn, now } = core

  /** Snoozes still running today, by "reminderId:rowId:userId". */
  async function snoozes(tenant: string, trackerId: string, today: string) {
    const r = await db
      .from('tenant_tracker_changes')
      .select('row_id,actor_id,detail')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .eq('kind', SNOOZE)
      .limit(2000)
    check(r.error)
    const held = new Set<string>()
    for (const entry of r.data || [])
      if (String(entry.detail?.until || '') >= today)
        held.add(`${entry.detail?.reminderId}:${entry.row_id}:${entry.actor_id}`)
    return held
  }

  /**
   * One tenant's reminders for today: the notifications to add. Recipients must be active and able to see the tracker.
   */
  async function dueFor(tenant: string, state: any, today: string) {
    const r = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).limit(1000)
    check(r.error)
    const accounts = (Array.isArray(state?.accounts) ? state.accounts : []).filter(
      (account: any) => account?.status === 'Active' && account.id,
    )
    const lookupBase = makeLookup(state?.items || [], state?.accounts || [], today)
    const existing = new Set(
      (Array.isArray(state?.notifications) ? state.notifications : []).map((item: any) => item?.dedupeKey),
    )
    const added: any[] = []
    for (const tracker of r.data || []) {
      if (tracker.archived_at) continue
      const columns = columnsOf(tracker)
      const reminders = cleanTimelineSettings(tracker.timeline, columns).reminders || []
      if (!reminders.some(reminder => !reminder.off)) continue
      const canSee = (id: string) => {
        const account = accounts.find((item: any) => String(item.id) === id)
        if (!account) return false
        if (tracker.private && tracker.created_by !== id) return false
        const user: User = {
          id,
          name: String(account.name || account.username || ''),
          role: String(account.role || ''),
          organizationId: tenant,
        }
        return trackerVisibleIn(state, user)(tracker)
      }
      const held = await snoozes(tenant, tracker.id, today)
      const lookup = { ...lookupBase, columns }
      for (const raw of await allRows(tenant, tracker.id)) {
        const row = rowOut(raw, columns)
        for (const reminder of reminders) {
          const due = reminderDue(reminder, row, columns, lookup, today)
          if (!due.due) continue
          const text = reminderText(row, columns, reminder, due, tracker.name)
          for (const person of reminderPeople(reminder, row, columns, lookup, tracker.created_by || '')) {
            const key = reminderKey(tracker.id, reminder.id, row.id, person, today)
            if (existing.has(key) || held.has(`${reminder.id}:${row.id}:${person}`) || !canSee(person)) continue
            existing.add(key)
            added.push({
              id: randomUUID(),
              dedupeKey: key,
              recipientUserId: person,
              createdAt: now(),
              type: 'tracker_reminder',
              scope: 'personal',
              severity: text.severity,
              title: text.title,
              message: text.message,
              trackerId: tracker.id,
              trackerRowId: row.id,
              trackerReminderId: reminder.id,
            })
          }
        }
      }
    }
    return added
  }

  /** Adds today's reminders to one tenant's notifications. Returns how many were added. */
  async function runTenant(tenant: string, today: string) {
    if (!deps.commit) return 0
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await deps.load(tenant)
      if (!current.data) return 0
      const added = await dueFor(tenant, current.data, today)
      if (!added.length) return 0
      const existing = Array.isArray(current.data.notifications) ? current.data.notifications : []
      try {
        await deps.commit(
          tenant,
          { ...current.data, notifications: [...added, ...existing].slice(0, NOTIFICATIONS_KEPT) },
          { id: 'system', name: 'Tracker reminders', role: 'Administrator', organizationId: tenant },
          'tracker-reminders',
          current.data,
        )
        return added.length
      } catch {
        /* Someone saved at the same moment: read again and try once more. */
      }
    }
    return 0
  }

  // The day each tenant was last checked, on this server. The notification keys keep it right across servers.
  const checked = new Map<string, string>()
  /** Runs today's check for every tenant with reminders, once a day after the reminder hour. */
  async function runDue(at = new Date()) {
    if (!reminderHourReached(businessHour(at, timeZone))) return
    const today = dateKeyInTimeZone(at, timeZone)
    const r = await db.from('tenant_trackers').select('tenant_id,timeline').limit(5000)
    if (r.error) return
    const tenants = new Set<string>()
    for (const tracker of r.data || [])
      if (Array.isArray(tracker?.timeline?.reminders) && tracker.timeline.reminders.length)
        tenants.add(tracker.tenant_id)
    for (const tenant of tenants) {
      if (checked.get(tenant) === today) continue
      try {
        await runTenant(tenant, today)
        checked.set(tenant, today)
      } catch (error: any) {
        console.error('Tracker reminders failed:', error?.message || error)
      }
    }
  }

  function routes(app: Express) {
    const { scope, route, who, idParam, trackerRow, oneRow } = core
    const limit = rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: req => `${who(req).organizationId}:${who(req).id}`,
      message: { error: 'Too many snoozes in a minute. Wait a moment and try again.' },
    })
    // Snoozes one row's reminder for the person asking: no reminder for it reaches them for that many days.
    app.post(
      '/api/trackers/:id/reminders/snooze',
      ...scope,
      limit,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        await trackerRow(tenant, id, user)
        const row = await oneRow(tenant, id, String(req.body?.rowId || ''))
        const reminderId = String(req.body?.reminderId || '')
        if (!/^[a-z0-9_]{3,40}$/i.test(reminderId)) throw new TrackerError('Reminder not found.', 404)
        const days = Math.min(30, Math.max(1, Math.round(Number(req.body?.days) || 1)))
        const today = dateKeyInTimeZone(new Date(now()), timeZone)
        const until = new Date(`${today}T00:00:00Z`)
        until.setUTCDate(until.getUTCDate() + days)
        const entry = {
          id: randomUUID(),
          tenant_id: tenant,
          tracker_id: id,
          row_id: row.id,
          actor_id: user.id,
          actor_name: user.name,
          kind: SNOOZE,
          detail: { reminderId, until: until.toISOString().slice(0, 10) },
          created_at: now(),
        }
        check((await db.from('tenant_tracker_changes').insert(entry)).error)
        res.json({ until: entry.detail.until })
      }),
    )
  }

  return { runDue, runTenant, dueFor, routes }
}
