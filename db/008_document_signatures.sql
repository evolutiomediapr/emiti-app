-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-07-09.
-- Feature "Firma remota del cliente" (estimates), Fase F1: tabla de firmas + RLS.
--
-- Estado escrito por el SERVER fuera del JSON de invoices (regla de sync
-- unidireccional: el push wholesale local->nube jamás toca esta tabla; la app
-- la trae con pull explícito, patrón refreshPaymentStatuses). Escritura
-- EXCLUSIVA por service-role (api/sign-document.js, F2): sin políticas de
-- INSERT/UPDATE/DELETE. Lectura solo del dueño; el visor anónimo consulta el
-- estado vía GET al endpoint, NUNCA por PostgREST (firma manuscrita + nombre
-- del firmante = dato sensible; no debe ser legible por cualquiera con el link).
--
-- doc_snapshot + doc_hash: evidencia legal de QUÉ versión exacta aceptó el
-- cliente, inmune al overwrite del sync (el JSON vivo de invoices cambia con
-- cada edit; esto no). Snapshot COMPLETO (incluye logo base64): decisión
-- consciente — reconstruir exactamente lo que el cliente vio vale más que el
-- espacio (50-500KB/fila, una fila por cotización firmada, TOAST lo maneja).
-- doc_hash = sha256 hex del snapshot, computado server-side al firmar: prueba
-- que el snapshot no fue alterado post-hoc.
--
-- one_signature_per_document (UNIQUE invoice_id) es el ENFORCEMENT real de
-- una-firma-por-documento: INSERT (no upsert) en el endpoint -> el segundo
-- intento recibe 23505 -> 409. El bloqueo visual del visor es solo UX.
-- doc_type genérico ('estimate' hoy, 'contract' futuro); si contratos
-- necesitaran multi-firma se migra el unique a (invoice_id, doc_type).
--
-- El borrado de cuenta (RPC delete_user) elimina auth.users -> el FK con
-- on delete cascade limpia las firmas, igual que expenses (db/005).

create table if not exists public.document_signatures (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    bigint not null references public.invoices(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  doc_type      text not null default 'estimate' check (doc_type in ('estimate','contract')),
  signer_name   text not null,
  signature_png text not null,           -- data-URL png (mismo formato que inv.clientSig)
  doc_hash      text not null,           -- sha256 hex de doc_snapshot (integridad)
  doc_snapshot  text not null,           -- row.data completo al momento de firmar (contenido)
  signed_at     timestamptz not null default now(),  -- server timestamp (autoritativo)
  viewed_at     timestamptz,             -- cuándo el visor cargó el doc (afirmado por el cliente)
  ip            text,
  user_agent    text,
  constraint one_signature_per_document unique (invoice_id)
);

-- Pull de la app: "mis firmas" por lote de invoice_ids del dueño.
create index if not exists idx_docsig_owner on public.document_signatures (owner_user_id);

alter table public.document_signatures enable row level security;

-- Dueño lee las firmas de sus documentos (refreshSignatures en la app, F4).
create policy "docsig: owner select own" on public.document_signatures
  for select to authenticated
  using (owner_user_id = auth.uid());

-- Sin política para anon: la tabla es invisible al visor público por PostgREST.
-- Sin políticas de escritura: la única vía es el endpoint service-role.
