-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-07-05.
-- Verificado con simulación RLS: insert Free rechazado (42501), insert Pro en
-- su carpeta aceptado, insert Pro en carpeta ajena rechazado (42501).
-- Feature "Gastos" (Pro-only), Fase G2: bucket PRIVADO para fotos de recibos.
--
-- A diferencia de document-photos (public-read: sus fotos aparecen en el visor
-- público de facturas), los recibos son datos internos del negocio: bucket
-- privado y lectura owner-only. El cliente los sirve con signed URLs de 1h
-- (createSignedUrls); la creación de la URL firmada pasa por la policy de
-- SELECT, así que solo el dueño puede firmarlas.
--
-- Paths: {userId}/{uuid}.jpg — mismo patrón carpeta-dueño y mismos nombres de
-- policy que document-photos (document_photos_owner_*). INSERT exige plan Pro
-- (igual que document_photos_owner_pro_insert y que expenses.insert): un
-- ex-Pro conserva la lectura de sus recibos pero no sube nuevos.
-- Límite 2 MB y solo image/jpeg: el pipeline de compresión (compressToJpeg)
-- siempre produce JPEG ~300 KB.
-- Sin policy de UPDATE: los uploads usan upsert:false y reemplazar = subir
-- path nuevo + borrar el viejo.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expense-receipts', 'expense-receipts', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

create policy "expense_receipts_owner_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'expense-receipts'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

create policy "expense_receipts_owner_pro_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'expense-receipts'
    and (storage.foldername(name))[1] = (auth.uid())::text
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and plan = 'pro'
    )
  );

create policy "expense_receipts_owner_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'expense-receipts'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );
