-- ============================================================
-- KENARRZ MARKET — Migrasi V4: Fix "column reference invoice_id
-- is ambiguous" pada complete_transaction (tombol SELESAIKAN
-- PESANAN di admin).
--
-- Penyebab: fungsi complete_transaction yang saat ini tersimpan
-- di database masih versi lama (sebelum fix alias tabel), meski
-- file migration_v3_kenarrz_upgrade.sql di repo sudah berisi versi
-- yang benar. CREATE OR REPLACE tidak menjamin definisi lama
-- benar-benar tertimpa kalau ada perbedaan cara load — DROP dulu
-- di sini untuk memastikan bersih.
--
-- Jalankan file ini SEKALI di SQL Editor Supabase kamu.
-- ============================================================

drop function if exists public.complete_transaction(text);
create or replace function public.complete_transaction(p_invoice_id text)
returns table (invoice_id text, transaction_status text)
language plpgsql security definer set search_path = public as $$
declare v_tx transactions%rowtype;
begin
  if not public.is_admin() then raise exception 'UNAUTHORIZED'; end if;
  -- PENTING: kolom "invoice_id" di klausa WHERE wajib diberi alias tabel
  -- (transactions.invoice_id), karena parameter OUT fungsi ini juga
  -- bernama "invoice_id" (dari RETURNS TABLE) — referensi tanpa alias
  -- jadi ambigu di PL/pgSQL.
  select * into v_tx from transactions where transactions.invoice_id = p_invoice_id for update;
  if not found then raise exception 'TRANSAKSI_TIDAK_DITEMUKAN'; end if;
  if v_tx.payment_status <> 'PAID' then raise exception 'PEMBAYARAN_BELUM_TERVERIFIKASI'; end if;
  update transactions set transaction_status = 'COMPLETED', completed_at = now()
    where transactions.id = v_tx.id;
  return query select v_tx.invoice_id, 'COMPLETED'::text;
end $$;
grant execute on function public.complete_transaction(text) to authenticated;
