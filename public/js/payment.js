/* ============================================================
   KENARRZ MARKET — payment.js
   Halaman pembayaran QRIS DANA Bisnis MANUAL. Website ini TIDAK
   PERNAH mengklaim pembayaran otomatis berhasil — status PAID
   hanya ditetapkan oleh admin. Halaman ini:
   - Ambil detail transaksi via RPC get_transaction_by_invoice
     (invoice_id berfungsi sebagai token akses acak).
   - Tampilkan QRIS dari Supabase Storage (bukan hardcode).
   - Terima upload bukti pembayaran → RPC submit_payment_proof.
   - Polling berkala (bukan Supabase Realtime, karena tabel
     transactions tidak punya SELECT policy untuk anon) supaya
     status ikut update saat admin approve/reject.
   ============================================================ */

(function () {
  const root = document.querySelector('[data-payment-root]');
  if (!root) return;

  const params = new URLSearchParams(window.location.search);
  const invoiceId = params.get('invoice');

  const loadingEl = document.querySelector('[data-payment-loading]');
  const notFoundEl = document.querySelector('[data-payment-not-found]');

  if (!invoiceId) {
    loadingEl?.remove();
    if (notFoundEl) notFoundEl.style.display = 'block';
    return;
  }

  let pollTimer = null;
  let countdownTimer = null;
  let selectedFile = null;
  let currentTx = null;

  const STATUS_LABEL = {
    PENDING_PAYMENT: 'Menunggu Pembayaran',
    PROOF_SUBMITTED: 'Menunggu Verifikasi Admin',
    VERIFYING: 'Menunggu Verifikasi Admin',
    PAID: 'Pembayaran Diverifikasi',
    REJECTED: 'Pembayaran Ditolak',
    EXPIRED: 'Transaksi Kedaluwarsa',
    COMPLETED: 'Selesai',
  };

  const STATUS_BADGE_CLASS = {
    PENDING_PAYMENT: 'badge--pending',
    PROOF_SUBMITTED: 'badge--verifying',
    VERIFYING: 'badge--verifying',
    PAID: 'badge--paid',
    REJECTED: 'badge--rejected',
    EXPIRED: 'badge--expired',
    COMPLETED: 'badge--paid',
  };

  const STATUS_EMOJI = {
    PENDING_PAYMENT: '🟡',
    PROOF_SUBMITTED: '🔵',
    VERIFYING: '🔵',
    PAID: '🟢',
    REJECTED: '🔴',
    EXPIRED: '⚫',
  };

  // ── URL Tracking: tampilkan & siapkan tombol salin/bagikan ──
  function setupUrlTracking() {
    const urlInput = document.querySelector('[data-payment-url-input]');
    const fullUrl = window.location.href;
    if (urlInput) urlInput.value = fullUrl;

    document.querySelector('[data-copy-url-btn]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(fullUrl);
        KENARRZ.toast('URL transaksi berhasil disalin.', 'success');
      } catch (e) {
        urlInput?.select();
        KENARRZ.toast('Gagal menyalin otomatis — silakan salin manual.', 'error');
      }
    });

    const shareBtn = document.querySelector('[data-share-url-btn]');
    if (shareBtn && navigator.share) {
      shareBtn.style.display = '';
      shareBtn.addEventListener('click', async () => {
        try {
          await navigator.share({ title: 'URL Transaksi KENARRZ MARKET', url: fullUrl });
        } catch (e) {
          /* dibatalkan user, abaikan */
        }
      });
    }
  }

  // ── Timeline status pesanan (spek: 5 tahap) ──────────────────
  function renderTimeline(tx) {
    const el = document.querySelector('[data-payment-timeline]');
    if (!el) return;

    if (tx.payment_status === 'REJECTED') {
      el.innerHTML = `
        <li class="tx-timeline__item is-done"><span class="tx-timeline__icon">✓</span> Pesanan dibuat</li>
        <li class="tx-timeline__item is-done"><span class="tx-timeline__icon">✓</span> Bukti pembayaran dikirim</li>
        <li class="tx-timeline__item is-rejected"><span class="tx-timeline__icon">✕</span> Pembayaran ditolak admin</li>`;
      return;
    }
    if (tx.payment_status === 'EXPIRED') {
      el.innerHTML = `
        <li class="tx-timeline__item is-done"><span class="tx-timeline__icon">✓</span> Pesanan dibuat</li>
        <li class="tx-timeline__item is-rejected"><span class="tx-timeline__icon">⏱</span> Kedaluwarsa — pembayaran tidak dikonfirmasi tepat waktu</li>`;
      return;
    }

    const steps = [
      { key: 'created', label: 'Pesanan dibuat' },
      { key: 'awaiting', label: 'Menunggu pembayaran' },
      { key: 'proof', label: 'Bukti pembayaran dikirim' },
      { key: 'verify', label: 'Verifikasi admin' },
      { key: 'done', label: 'Pesanan selesai' },
    ];

    let currentIdx = 0;
    if (tx.payment_status === 'PENDING_PAYMENT') currentIdx = 1;
    else if (['PROOF_SUBMITTED', 'VERIFYING'].includes(tx.payment_status)) currentIdx = 2;
    else if (tx.payment_status === 'PAID' && tx.transaction_status !== 'COMPLETED') currentIdx = 3;
    else if (tx.payment_status === 'PAID' && tx.transaction_status === 'COMPLETED') currentIdx = 4;

    el.innerHTML = steps
      .map((step, idx) => {
        let cls = 'is-pending';
        let icon = '○';
        if (idx < currentIdx) {
          cls = 'is-done';
          icon = '✓';
        } else if (idx === currentIdx) {
          cls = 'is-current';
          icon = '●';
        }
        return `<li class="tx-timeline__item ${cls}"><span class="tx-timeline__icon">${icon}</span> ${step.label}</li>`;
      })
      .join('');
  }

  // ── AKUN ANDA: hanya diambil & ditampilkan setelah COMPLETED ─
  async function renderCredentialsIfCompleted(tx) {
    const block = document.querySelector('[data-payment-credentials-block]');
    if (!block) return;
    if (tx.payment_status !== 'PAID' || tx.transaction_status !== 'COMPLETED') {
      block.style.display = 'none';
      return;
    }
    block.style.display = '';
    const loadingEl = block.querySelector('[data-payment-credentials-loading]');
    const emailInput = block.querySelector('[data-cred-email]');
    const passwordInput = block.querySelector('[data-cred-password]');
    if (emailInput.dataset.loaded === '1') return; // sudah pernah dimuat, jangan fetch ulang tiap poll
    try {
      const { data, error } = await supabaseClient.rpc('get_purchased_account_credentials', { p_invoice_id: invoiceId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      emailInput.value = row?.account_email || '-';
      passwordInput.value = row?.account_password || '-';
      emailInput.dataset.loaded = '1';
      if (loadingEl) loadingEl.style.display = 'none';
    } catch (e) {
      if (loadingEl) loadingEl.textContent = 'Data akun belum dapat dimuat. Silakan refresh halaman.';
    }
  }

  document.querySelector('[data-toggle-cred-password-btn]')?.addEventListener('click', (e) => {
    const input = document.querySelector('[data-cred-password]');
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    e.target.textContent = isHidden ? 'Sembunyikan Password' : 'Tampilkan Password';
  });
  document.querySelector('[data-copy-email-btn]')?.addEventListener('click', async () => {
    const val = document.querySelector('[data-cred-email]').value;
    try {
      await navigator.clipboard.writeText(val);
      KENARRZ.toast('Email berhasil disalin.', 'success');
    } catch (e) {
      KENARRZ.toast('Gagal menyalin.', 'error');
    }
  });
  document.querySelector('[data-copy-password-btn]')?.addEventListener('click', async () => {
    const val = document.querySelector('[data-cred-password]').value;
    try {
      await navigator.clipboard.writeText(val);
      KENARRZ.toast('Password berhasil disalin.', 'success');
    } catch (e) {
      KENARRZ.toast('Gagal menyalin.', 'error');
    }
  });

  function extFromMime(mime) {
    switch (mime) {
      case 'image/jpeg':
      case 'image/jpg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      default:
        return null;
    }
  }

  async function fetchTransaction() {
    const { data, error } = await supabaseClient.rpc('get_transaction_by_invoice', { p_invoice_id: invoiceId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row || null;
  }

  function fmtDateTime(iso) {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return iso;
    }
  }

  function renderCountdown(expiresAt) {
    const row = document.querySelector('[data-payment-countdown-row]');
    const el = document.querySelector('[data-payment-countdown]');
    if (!expiresAt) {
      row.style.display = 'none';
      return;
    }
    row.style.display = '';
    clearInterval(countdownTimer);

    function tick() {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        el.textContent = 'Kedaluwarsa';
        clearInterval(countdownTimer);
        refreshAfterExpiry();
        return;
      }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      el.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    }
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  async function refreshAfterExpiry() {
    try {
      await supabaseClient.rpc('expire_stale_transactions');
    } catch (e) {
      /* abaikan */
    }
    loadAndRender();
  }

  async function loadQrisAndSettings() {
    const settings = (await KENARRZ.loadSettings()) || {};
    const merchantEl = document.querySelector('[data-payment-merchant-name]');
    if (merchantEl) merchantEl.textContent = settings.merchant_name || settings.site_name || 'KENARRZ MARKET';

    const danaNumberRow = document.querySelector('[data-payment-dana-number-row]');
    const danaNumberEl = document.querySelector('[data-payment-dana-number]');
    if (settings.dana_business_number) {
      danaNumberRow.style.display = '';
      danaNumberEl.textContent = settings.dana_business_number;
    }

    const qrisWrap = document.querySelector('[data-payment-qris-image]');
    if (settings.qris_image_path) {
      const { data: pub } = supabaseClient.storage.from('payment-assets').getPublicUrl(settings.qris_image_path);
      if (pub?.publicUrl) {
        qrisWrap.innerHTML = `<img src="${KENARRZ.escapeAttr(pub.publicUrl)}" alt="QRIS DANA Bisnis KENARRZ MARKET" />`;
      }
    }

    const instructionsEl = document.querySelector('[data-payment-instructions]');
    const instructionText = settings.payment_instruction || WA_TEMPLATES.DEFAULT_PAYMENT_INSTRUCTION;
    instructionsEl.innerHTML = instructionText
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean)
      .map((line) => `<li>${KENARRZ.escapeAttr(line)}</li>`)
      .join('');

    return settings;
  }

  function renderTransaction(tx, settings) {
    document.querySelector('[data-payment-invoice]').textContent = tx.invoice_id;
    document.querySelector('[data-payment-account-name]').textContent = tx.account_name || '-';
    document.querySelector('[data-payment-account-code]').textContent = tx.account_code || '-';
    document.querySelector('[data-payment-platform]').textContent = tx.platform || '-';
    document.querySelector('[data-payment-category]').textContent = tx.category_name || '-';
    document.querySelector('[data-payment-price]').textContent = KENARRZ.formatRupiah(tx.price);
    document.querySelector('[data-payment-total]').textContent = KENARRZ.formatRupiah(tx.price);

    const badge = document.querySelector('[data-payment-status-badge]');
    const emoji = STATUS_EMOJI[tx.payment_status] ? STATUS_EMOJI[tx.payment_status] + ' ' : '';
    const label = tx.payment_status === 'PAID' && tx.transaction_status === 'COMPLETED' ? '✅ Pesanan Selesai' : `${emoji}${STATUS_LABEL[tx.payment_status] || tx.payment_status}`;
    badge.textContent = label;
    badge.className = `badge ${STATUS_BADGE_CLASS[tx.payment_status] || 'badge--neutral'}`;

    renderTimeline(tx);
    renderCredentialsIfCompleted(tx);

    const descEl = document.querySelector('[data-payment-status-desc]');
    const qrisBlock = document.querySelector('[data-payment-qris-block]');
    const formBlock = document.querySelector('[data-payment-form-block]');
    const finalBlock = document.querySelector('[data-payment-final-block]');
    const finalIcon = document.querySelector('[data-payment-final-icon]');
    const finalTitle = document.querySelector('[data-payment-final-title]');
    const finalMessage = document.querySelector('[data-payment-final-message]');
    const rejectionBox = document.querySelector('[data-payment-rejection-box]');

    qrisBlock.style.display = 'none';
    formBlock.style.display = 'none';
    finalBlock.style.display = 'none';
    rejectionBox.style.display = 'none';
    descEl.textContent = '';

    switch (tx.payment_status) {
      case 'PENDING_PAYMENT':
        descEl.textContent = 'Pesanan kamu berhasil dibuat. Selesaikan pembayaran sebelum batas waktu habis.';
        qrisBlock.style.display = '';
        formBlock.style.display = '';
        renderCountdown(tx.expires_at);
        break;
      case 'PROOF_SUBMITTED':
      case 'VERIFYING':
        clearInterval(countdownTimer);
        document.querySelector('[data-payment-countdown-row]').style.display = 'none';
        finalBlock.style.display = '';
        finalIcon.textContent = '⏳';
        finalTitle.textContent = 'Menunggu Verifikasi Admin';
        finalMessage.textContent = 'Bukti pembayaran kamu sudah kami terima dan sedang menunggu verifikasi manual dari admin. Admin akan memeriksa bukti pembayaran secara manual.';
        break;
      case 'PAID':
        clearInterval(countdownTimer);
        finalBlock.style.display = '';
        if (tx.transaction_status === 'COMPLETED') {
          finalIcon.textContent = '✅';
          finalTitle.textContent = 'Pesanan Selesai';
          finalMessage.textContent = 'Pesanan Anda sudah selesai. Data akun tersedia di bagian "AKUN ANDA" di bawah.';
          stopPolling();
        } else {
          finalIcon.textContent = '✓';
          finalTitle.textContent = 'Pembayaran Anda Telah Diverifikasi';
          finalMessage.textContent = 'Pembayaran sedang diproses. Data akun akan tampil di halaman ini setelah admin menyelesaikan pesanan — tetap simpan URL transaksi ini.';
          // Tetap polling — admin bisa menyelesaikan pesanan kapan saja.
        }
        break;
      case 'COMPLETED':
        clearInterval(countdownTimer);
        finalBlock.style.display = '';
        finalIcon.textContent = '✓';
        finalTitle.textContent = 'Transaksi Selesai';
        finalMessage.textContent = 'Akun sudah diserahkan. Terima kasih sudah berbelanja di KENARRZ MARKET.';
        stopPolling();
        break;
      case 'REJECTED':
        clearInterval(countdownTimer);
        finalBlock.style.display = '';
        finalIcon.textContent = '✕';
        finalTitle.textContent = 'Pembayaran Ditolak';
        finalMessage.textContent = 'Admin menolak bukti pembayaran untuk transaksi ini.';
        if (tx.rejection_reason) {
          rejectionBox.style.display = '';
          document.querySelector('[data-payment-rejection-reason]').textContent = tx.rejection_reason;
        }
        stopPolling();
        break;
      case 'EXPIRED':
        clearInterval(countdownTimer);
        finalBlock.style.display = '';
        finalIcon.textContent = '⏱';
        finalTitle.textContent = 'Transaksi Kedaluwarsa';
        finalMessage.textContent = 'Transaksi ini telah kedaluwarsa karena tidak ada pembayaran yang dikonfirmasi tepat waktu. Silakan buat pesanan baru.';
        stopPolling();
        break;
      default:
        descEl.textContent = '';
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const tx = await fetchTransaction();
        if (!tx) return;
        currentTx = tx;
        const settings = KENARRZ.getSettings() || {};
        renderTransaction(tx, settings);
      } catch (e) {
        /* diamkan — coba lagi di polling berikutnya */
      }
    }, 6000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function loadAndRender() {
    try {
      const [tx, settings] = await Promise.all([fetchTransaction(), loadQrisAndSettings()]);
      if (!tx) {
        loadingEl?.remove();
        if (notFoundEl) notFoundEl.style.display = 'block';
        return;
      }
      currentTx = tx;
      loadingEl?.remove();
      root.style.display = '';
      renderTransaction(tx, settings);
      if (['PENDING_PAYMENT', 'PROOF_SUBMITTED', 'VERIFYING'].includes(tx.payment_status) ||
          (tx.payment_status === 'PAID' && tx.transaction_status !== 'COMPLETED')) {
        startPolling();
      }
    } catch (e) {
      loadingEl?.remove();
      if (notFoundEl) {
        notFoundEl.style.display = 'block';
        notFoundEl.querySelector('p').textContent = 'Transaksi tidak dapat dimuat. Silakan coba lagi.';
      }
    }
  }

  // ── Upload bukti pembayaran ─────────────────────────────────
  const proofInput = document.querySelector('[data-payment-proof-input]');
  const proofPreview = document.querySelector('[data-payment-proof-preview]');
  const dropzone = document.querySelector('[data-payment-dropzone]');

  function renderProofPreview() {
    proofPreview.innerHTML = '';
    if (!selectedFile) return;
    const url = URL.createObjectURL(selectedFile);
    const item = document.createElement('div');
    item.className = 'photo-preview-item';
    item.innerHTML = `<img src="${url}" alt="Bukti pembayaran" /><button type="button" class="photo-preview-item__remove" aria-label="Hapus foto">×</button>`;
    item.querySelector('button').addEventListener('click', () => {
      selectedFile = null;
      proofInput.value = '';
      renderProofPreview();
    });
    proofPreview.appendChild(item);
  }

  function handleFileSelect(file) {
    if (!file) return;
    const ext = extFromMime(file.type);
    if (!ext) {
      KENARRZ.toast('Format foto tidak didukung.', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      KENARRZ.toast('Ukuran foto maksimal 5 MB.', 'error');
      return;
    }
    selectedFile = file;
    renderProofPreview();
  }

  proofInput?.addEventListener('change', () => handleFileSelect(proofInput.files[0]));
  dropzone?.addEventListener('click', (e) => {
    if (e.target.closest('.photo-preview-item')) return;
    proofInput?.click();
  });
  ['dragover', 'dragenter'].forEach((evt) => {
    dropzone?.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone?.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  });
  dropzone?.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelect(file);
  });

  const paymentForm = document.querySelector('[data-payment-form]');
  paymentForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = paymentForm.querySelector('button[type="submit"]');
    const senderName = paymentForm.querySelector('[name="sender_name"]').value.trim();
    const senderNumber = paymentForm.querySelector('[name="sender_account_number"]').value.trim();

    if (!senderName) return KENARRZ.toast('Atas nama pengirim wajib diisi.', 'error');
    if (!senderNumber) return KENARRZ.toast('Nomor DANA/rekening pengirim wajib diisi.', 'error');
    if (!selectedFile) return KENARRZ.toast('Bukti pembayaran wajib diupload.', 'error');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Mengirim...';

    try {
      // Re-cek kedaluwarsa dulu supaya tidak mengunggah untuk transaksi yang sudah lewat waktu
      const fresh = await fetchTransaction();
      if (!fresh) throw new Error('Transaksi tidak ditemukan.');
      if (fresh.payment_status !== 'PENDING_PAYMENT') {
        throw new Error(
          fresh.payment_status === 'EXPIRED'
            ? 'Transaksi ini telah kedaluwarsa.'
            : 'Bukti pembayaran untuk transaksi ini sudah dikirim.'
        );
      }

      const ext = extFromMime(selectedFile.type);
      const path = `${invoiceId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const { error: uploadErr } = await supabaseClient.storage
        .from('payment-proofs')
        .upload(path, selectedFile, { contentType: selectedFile.type, upsert: false });
      if (uploadErr) {
        console.error('Upload bukti pembayaran gagal:', uploadErr);
        throw new Error(`Bukti pembayaran gagal diupload: ${uploadErr.message || uploadErr.error || 'penyebab tidak diketahui'}`);
      }

      const { data, error } = await supabaseClient.rpc('submit_payment_proof', {
        p_invoice_id: invoiceId,
        p_sender_name: senderName,
        p_sender_account_number: senderNumber,
        p_payment_proof_path: path,
      });
      if (error) {
        console.error('submit_payment_proof gagal:', error);
        const msg = error.message || '';
        const pgCode = error.code || '';
        if (msg.includes('TRANSAKSI_TIDAK_DITEMUKAN')) throw new Error('Transaksi tidak ditemukan.');
        if (msg.includes('TRANSAKSI_KEDALUWARSA')) throw new Error('Transaksi ini telah kedaluwarsa.');
        if (msg.includes('BUKTI_SUDAH_DIKIRIM')) throw new Error('Bukti pembayaran untuk transaksi ini sudah dikirim.');
        if (msg.includes('PEMBAYARAN_DITOLAK')) throw new Error('Pembayaran ditolak oleh admin.');
        if (msg.includes('NAMA_PENGIRIM_WAJIB_DIISI')) throw new Error('Atas nama pengirim wajib diisi.');
        if (msg.includes('NOMOR_PENGIRIM_WAJIB_DIISI')) throw new Error('Nomor DANA/rekening pengirim wajib diisi.');
        if (msg.includes('BUKTI_PEMBAYARAN_WAJIB_DIUPLOAD')) throw new Error('Bukti pembayaran wajib diupload.');
        if (pgCode === 'PGRST202' || pgCode === '42883' || msg.toLowerCase().includes('schema cache') || msg.toLowerCase().includes('could not find the function')) {
          throw new Error('Sistem pembayaran belum siap (fungsi database belum terpasang). Hubungi admin situs.');
        }
        // Tampilkan pesan error asli langsung di layar (bukan cuma console)
        // supaya bisa didiagnosis dari HP tanpa perlu buka DevTools.
        throw new Error(`Gagal mengirim bukti pembayaran: ${msg || 'penyebab tidak diketahui'} (${pgCode || 'no code'})`);
      }

      KENARRZ.toast('Bukti pembayaran berhasil dikirim. Pembayaran kamu sedang menunggu verifikasi admin.', 'success');

      // Buka WhatsApp admin dengan pesan transaksi (bukan klaim pembayaran berhasil)
      try {
        const settings = KENARRZ.getSettings() || {};
        const tpl = settings.payment_whatsapp_template || WA_TEMPLATES.DEFAULT_TEMPLATE_PAYMENT;
        const message = WA_TEMPLATES.fillTemplate(tpl, {
          INVOICE: invoiceId,
          'URL TRANSAKSI': window.location.href,
          'NAMA AKUN': fresh.account_name || '-',
          'ID AKUN': fresh.account_code || '-',
          PLATFORM: fresh.platform || '-',
          KATEGORI: fresh.category_name || '-',
          HARGA: WA_TEMPLATES.formatRupiah(fresh.price),
          EMAIL: fresh.buyer_email || '-',
          WHATSAPP: fresh.buyer_whatsapp || '-',
          INSTAGRAM: fresh.buyer_instagram || '-',
          'ATAS NAMA': senderName,
          'NOMOR PEMBAYAR': senderNumber,
        });
        KENARRZ.openWhatsApp(settings.admin_whatsapp, message);
      } catch (e) {
        /* jangan blokir alur utama kalau WhatsApp gagal dibuka */
      }

      selectedFile = null;
      loadAndRender();
    } catch (err) {
      KENARRZ.toast(err.message, 'error', 9000);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Kirim Bukti Pembayaran';
    }
  });

  window.addEventListener('beforeunload', () => {
    stopPolling();
    clearInterval(countdownTimer);
  });

  loadAndRender();
  setupUrlTracking();
})();
