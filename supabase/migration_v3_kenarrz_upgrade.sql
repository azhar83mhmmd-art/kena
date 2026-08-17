-- ============================================================
-- KENARRZ MARKET — Migrasi V3: Diskon, Kredensial Akun Aman,
-- dan Alur "Selesaikan Pesanan"
-- Jalankan SETELAH schema.sql + migration_pure_supabase.sql +
-- migration_manual_qris.sql. Aman dijalankan ulang (idempotent).
-- ============================================================

-- ============================================================
-- 1. SISTEM DISKON PADA ACCOUNTS
-- price tetap berarti "harga normal". discount_price adalah harga
-- setelah diskon. discount_percent dihitung otomatis dari kedua
-- angka itu (tidak diinput manual supaya tidak pernah nyasar beda
-- dari harga aslinya). discount_active mengontrol apakah diskon
-- sedang berlaku, discount_starts_at/discount_ends_at opsional
-- untuk jadwal diskon.
-- ============================================================
alter table accounts add column if not exists discount_price numeric(14,2);
alter table accounts add column if not exists discount_active boolean not null default false;
alter table accounts add column if not exists discount_starts_at timestamptz;
alter table accounts add column if not exists discount_ends_at timestamptz;
alter table accounts add column if not exists promo_label text;

alter table accounts drop constraint if exists accounts_discount_price_check;
alter table accounts add constraint accounts_discount_price_check
  check (discount_price is null or (discount_price >= 0 and discount_price < price));

-- Kolom generated: persentase diskon, selalu konsisten dengan price & discount_price.
alter table accounts drop column if exists discount_percent;
alter table accounts add column discount_percent int generated always as (
  case
    when discount_price is not null and price > 0
      then round(((price - discount_price) / price) * 100)
    else null
  end
) stored;

-- Helper: harga yang benar-benar berlaku sekarang (dipakai checkout & tampilan).
-- Dihitung ulang di server (RPC), TIDAK PERNAH dipercaya dari input frontend.
create or replace function public.effective_price(a accounts)
returns numeric
language sql stable as $$
  select case
    when a.discount_active
      and a.discount_price is not null
      and (a.discount_starts_at is null or a.discount_starts_at <= now())
      and (a.discount_ends_at is null or a.discount_ends_at >= now())
    then a.discount_price
    else a.price
  end;
$$;

-- ============================================================
-- 2. KREDENSIAL AKUN (email/password login akun yang dijual)
-- Disimpan di TABEL TERPISAH, sengaja BUKAN kolom di `accounts`,
-- karena `accounts` punya policy "publik boleh SELECT semua kolom".
-- Tabel ini TIDAK punya policy select untuk anon sama sekali —
-- satu-satunya jalur baca oleh pembeli adalah RPC SECURITY DEFINER
-- `get_purchased_account_credentials`, dan itu pun hanya mengembalikan
-- data kalau transaksi terkait sudah berstatus transaction_status = 'COMPLETED'.
-- ============================================================
create table if not exists account_credentials (
  account_id uuid primary key references accounts(id) on delete cascade,
  account_email text,
  account_password text,
  updated_at timestamptz not null default now()
);

alter table account_credentials enable row level security;

drop policy if exists "Admin kelola account_credentials" on account_credentials;
create policy "Admin kelola account_credentials" on account_credentials
  for all using (public.is_admin()) with check (public.is_admin());
-- Sengaja TIDAK ADA policy select untuk anon/authenticated non-admin.

drop trigger if exists trg_account_credentials_updated_at on account_credentials;
create trigger trg_account_credentials_updated_at before update on account_credentials
  for each row execute function set_updated_at();

-- ============================================================
-- 3. INVOICE ID PAKAI PREFIX "KNZ-" (bukan lagi ARRZ-/KENARRZ-)
-- Contoh: KNZ-20260816-8F42A1
-- ============================================================
create or replace function public.generate_invoice_id() returns text language plpgsql as $$
declare c text; begin
  loop
    c := 'KNZ-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text||clock_timestamp()::text),1,6));
    exit when not exists (select 1 from transactions where invoice_id = c);
  end loop;
  return c;
end $$;

-- ============================================================
-- 4. create_purchase_transaction — pakai effective_price(), bukan
-- accounts.price mentah, supaya diskon otomatis kepakai saat checkout
-- (bukan cuma tampilan di halaman produk).
-- ============================================================
-- DROP dulu sebelum CREATE OR REPLACE: fungsi ini sudah pernah dibuat oleh
-- migration_manual_qris.sql. Postgres/Supabase menolak CREATE OR REPLACE
-- kalau struktur kolom RETURNS TABLE berubah ("cannot change return type
-- of existing function"), jadi DROP FUNCTION IF EXISTS wajib ada di sini
-- supaya migration ini aman dijalankan ulang / setelah migration lain.
drop function if exists public.create_purchase_transaction(uuid, text, text, text);
create or replace function public.create_purchase_transaction(
  p_account_id uuid, p_buyer_email text, p_buyer_whatsapp text, p_buyer_instagram text
) returns table (invoice_id text, transaction_id uuid, expires_at timestamptz,
  account_name text, account_code text, platform text, category_name text, price numeric)
language plpgsql security definer set search_path = public as $$
declare v_acc accounts%rowtype; v_cat text; v_min int; v_inv text; v_exp timestamptz; v_id uuid; v_price numeric;
begin
  if p_buyer_email is null or btrim(p_buyer_email)='' then raise exception 'EMAIL_WAJIB_DIISI'; end if;
  if p_buyer_whatsapp is null or btrim(p_buyer_whatsapp)='' then raise exception 'WHATSAPP_WAJIB_DIISI'; end if;
  perform public.expire_stale_transactions();
  select * into v_acc from accounts where id = p_account_id for update;
  if not found then raise exception 'AKUN_TIDAK_DITEMUKAN'; end if;
  if v_acc.status <> 'AVAILABLE' then raise exception 'AKUN_TIDAK_TERSEDIA'; end if;
  v_price := public.effective_price(v_acc);
  select name into v_cat from categories where id = v_acc.category_id;
  select coalesce(payment_expiration_minutes,30) into v_min from site_settings where id=1;
  v_inv := public.generate_invoice_id();
  v_exp := now() + (coalesce(v_min,30) || ' minutes')::interval;
  update accounts set status='RESERVED' where id = p_account_id;
  begin
    insert into transactions (account_id, buyer_whatsapp, buyer_email, buyer_instagram, price,
      payment_method, payment_status, transaction_status, invoice_id, expires_at)
    values (p_account_id, p_buyer_whatsapp, btrim(p_buyer_email), nullif(btrim(coalesce(p_buyer_instagram,'')),''),
      v_price, 'QRIS_DANA_BISNIS', 'PENDING_PAYMENT', 'PENDING', v_inv, v_exp)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'AKUN_TIDAK_TERSEDIA';
  end;
  return query select v_inv, v_id, v_exp, v_acc.name, v_acc.account_code, v_acc.platform, v_cat, v_price;
end $$;
grant execute on function public.create_purchase_transaction(uuid,text,text,text) to anon, authenticated;

-- ============================================================
-- 5. "SELESAIKAN PESANAN" — status transaksi bertahap.
-- payment_status PAID (dari migration_manual_qris) HANYA berarti
-- "pembayaran diverifikasi", BUKAN "data akun boleh tampil".
-- transaction_status baru berubah ke COMPLETED lewat tombol admin
-- terpisah ("Selesaikan Pesanan"), dan HANYA setelah itu kredensial
-- boleh dibaca lewat RPC di bawah.
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
  -- bernama "invoice_id" (dari RETURNS TABLE). Di PL/pgSQL, nama kolom
  -- OUT otomatis jadi variabel dalam scope fungsi, sehingga referensi
  -- kolom tanpa alias jadi ambigu — persis penyebab error
  -- "column reference invoice_id is ambiguous" saat tombol SELESAIKAN
  -- PESANAN ditekan.
  select * into v_tx from transactions where transactions.invoice_id = p_invoice_id for update;
  if not found then raise exception 'TRANSAKSI_TIDAK_DITEMUKAN'; end if;
  if v_tx.payment_status <> 'PAID' then raise exception 'PEMBAYARAN_BELUM_TERVERIFIKASI'; end if;
  update transactions set transaction_status = 'COMPLETED', completed_at = now()
    where transactions.id = v_tx.id;
  return query select v_tx.invoice_id, 'COMPLETED'::text;
end $$;
grant execute on function public.complete_transaction(text) to authenticated;

-- Pembeli membaca kredensial akun HANYA lewat fungsi ini, HANYA kalau
-- transaksinya sendiri sudah COMPLETED. invoice_id berfungsi sebagai
-- token akses (acak, dikirim balik ke pembeli lewat URL tracking).
drop function if exists public.get_purchased_account_credentials(text);
create or replace function public.get_purchased_account_credentials(p_invoice_id text)
returns table (account_email text, account_password text)
language plpgsql security definer set search_path = public as $$
declare v_tx transactions%rowtype;
begin
  select * into v_tx from transactions where invoice_id = p_invoice_id;
  if not found then raise exception 'TRANSAKSI_TIDAK_DITEMUKAN'; end if;
  if v_tx.transaction_status <> 'COMPLETED' or v_tx.payment_status <> 'PAID' then
    raise exception 'PESANAN_BELUM_SELESAI';
  end if;
  return query
    select c.account_email, c.account_password
    from account_credentials c
    where c.account_id = v_tx.account_id;
end $$;
grant execute on function public.get_purchased_account_credentials(text) to anon, authenticated;

-- get_transaction_by_invoice: tambahkan transaction_status & completed_at
-- (dipakai halaman status untuk tahu kapan boleh menawarkan tombol
-- "Lihat Data Akun"), tetap TIDAK mengembalikan kredensial.
-- PENTING: fungsi ini sudah ada dari migration_manual_qris.sql dengan
-- kolom RETURNS TABLE yang berbeda (tidak ada completed_at). Ini akar
-- penyebab error "cannot change return type of existing function" saat
-- migration ini dijalankan di Supabase — CREATE OR REPLACE tidak boleh
-- mengubah bentuk RETURNS TABLE, jadi harus DROP FUNCTION dulu.
drop function if exists public.get_transaction_by_invoice(text);
create or replace function public.get_transaction_by_invoice(p_invoice_id text)
returns table (invoice_id text, payment_status text, transaction_status text, price numeric,
  buyer_email text, buyer_whatsapp text, buyer_instagram text, payment_proof_path text,
  rejection_reason text, expires_at timestamptz, created_at timestamptz,
  payment_submitted_at timestamptz, verified_at timestamptz, completed_at timestamptz,
  account_id uuid, account_name text, account_code text, platform text, category_name text)
language sql security definer set search_path = public stable as $$
  select t.invoice_id, t.payment_status, t.transaction_status, t.price, t.buyer_email, t.buyer_whatsapp,
    t.buyer_instagram, t.payment_proof_path, t.rejection_reason, t.expires_at, t.created_at,
    t.payment_submitted_at, t.verified_at, t.completed_at, a.id, a.name, a.account_code, a.platform, c.name
  from transactions t
  left join accounts a on a.id = t.account_id
  left join categories c on c.id = a.category_id
  where t.invoice_id = p_invoice_id limit 1;
$$;
grant execute on function public.get_transaction_by_invoice(text) to anon, authenticated;

-- ============================================================
-- 6. SELL_REQUESTS — tambahkan field kredensial akun yang diajukan
-- jual. Tabel ini SUDAH TIDAK punya policy select untuk anon sejak
-- migration_pure_supabase.sql (hanya admin), jadi aman menambah
-- kolom sensitif di sini.
-- ============================================================
alter table sell_requests add column if not exists account_email text;
alter table sell_requests add column if not exists account_password text;

-- ============================================================
-- 7. REALTIME untuk account_credentials tidak perlu didaftarkan
-- (tidak ada UI publik yang subscribe ke tabel ini).
-- ============================================================
