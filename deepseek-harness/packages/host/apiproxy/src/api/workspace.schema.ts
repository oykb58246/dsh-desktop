/**
 * workspace domain zod schemas (names derived from map keys). The
 * WorkspaceId brand cast lives in sessions.schema (see the note there) and
 * is re-exported here as the domain-local name.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorkspaceView } from './workspace.ts'
import { sessionIdSchema, workspaceIdSchema } from './sessions.schema.ts'

export { workspaceIdSchema } from './sessions.schema.ts'

/** WorkspaceView row of every workspace.* response. */
export const workspaceViewSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionIdSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Wire<WorkspaceView>>

/** workspace.list request payload (empty object literal). */
export const workspaceListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'workspace.list'>>>

/**
 * The workspace-list-shaped snapshot value shared by list/archive/unarchive:
 * the visible (unarchived) workspace rows plus both registry-global archive
 * sets, so a client installs the whole post-mutation state from one value.
 */
const workspaceSnapshotValueSchema = z.object({
  items: z.array(workspaceViewSchema),
  archivedSessionIds: z.array(sessionIdSchema),
  archivedWorkspaceIds: z.array(workspaceIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.list'>>>

/** workspace.list response value. */
export const workspaceListValueSchema = workspaceSnapshotValueSchema

/** workspace.listArchived request payload (empty object literal). */
export const workspaceListArchivedRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'workspace.listArchived'>>>

/** workspace.listArchived response value: archived workspace views plus the session archive set. */
export const workspaceListArchivedValueSchema = z.object({
  workspaces: z.array(workspaceViewSchema),
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.listArchived'>>>

/** workspace.create request payload: the existing directory to adopt. */
export const workspaceCreateRequestSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.create'>>>

/** workspace.create response value. */
export const workspaceCreateValueSchema = z.object({
  workspace: workspaceViewSchema,
  created: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.create'>>>

/** workspace.rename request payload: the new title must be non-blank. */
export const workspaceRenameRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string(),
}).refine(
  payload => payload.title.trim() !== '',
  { message: 'workspace.rename requires a non-blank title' },
) satisfies z.ZodType<Wire<RequestPayload<'workspace.rename'>>>

/** workspace.rename response value. */
export const workspaceRenameValueSchema = z.object({
  workspace: workspaceViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.rename'>>>

/** workspace.delete request payload. */
export const workspaceDeleteRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.delete'>>>

/** workspace.delete response value. */
export const workspaceDeleteValueSchema = z.object({
  deleted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.delete'>>>

/** workspace.insertBefore request payload (anchor omitted = append to end). */
export const workspaceInsertBeforeRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  beforeWorkspaceId: workspaceIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.insertBefore'>>>

/** workspace.insertBefore response value: the complete durable display order. */
export const workspaceInsertBeforeValueSchema = z.object({
  workspaceIds: z.array(workspaceIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.insertBefore'>>>

/** workspace.insertSessionBefore request payload (anchor omitted = append to end). */
export const workspaceInsertSessionBeforeRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  sessionId: sessionIdSchema,
  beforeSessionId: sessionIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.insertSessionBefore'>>>

/** workspace.insertSessionBefore response value. */
export const workspaceInsertSessionBeforeValueSchema = z.object({
  workspace: workspaceViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.insertSessionBefore'>>>

/** workspace.archiveSession request payload. */
export const workspaceArchiveSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.archiveSession'>>>

/** workspace.archiveSession response value: the full updated archive set. */
export const workspaceArchiveSessionValueSchema = z.object({
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.archiveSession'>>>

/** workspace.archive request payload. */
export const workspaceArchiveRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.archive'>>>

/** workspace.archive response value: the full post-mutation snapshot (same shape as workspace.list). */
export const workspaceArchiveValueSchema = workspaceSnapshotValueSchema

/** workspace.unarchive request payload. */
export const workspaceUnarchiveRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.unarchive'>>>

/** workspace.unarchive response value: the full post-mutation snapshot (same shape as workspace.list). */
export const workspaceUnarchiveValueSchema = workspaceSnapshotValueSchema

/** workspace.unarchiveSession request payload. */
export const workspaceUnarchiveSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.unarchiveSession'>>>

/** workspace.unarchiveSession response value: the full updated session archive set. */
export const workspaceUnarchiveSessionValueSchema = z.object({
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.unarchiveSession'>>>
