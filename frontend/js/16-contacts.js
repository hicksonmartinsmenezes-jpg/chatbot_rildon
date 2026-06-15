// 16-contacts.js — Painel de Contatos

let _contactsPage    = 1;
let _contactsTotal   = 0;
let _contactsLimit   = 40;
let _contactsSearch  = "";
let _contactsTag     = "";
let _contactsStatus  = "";
let _contactsSelected = new Set();
let _contactsPollTimer = null;
let _contactsEditingId = null;

const ESTADOS_BR = [
  "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG",
  "PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatContactPhone(num) {
  const d = String(num || "").replace(/\D/g, "");
  if (d.length === 13) return `+${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return num;
}

function contactInitials(nome) {
  const parts = String(nome || "?").trim().split(" ").filter(Boolean);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : parts[0].slice(0, 2).toUpperCase();
}

function contactAvatarColor(nome) {
  const colors = ["#1d6cf5","#7c3aed","#db2777","#059669","#d97706","#0891b2"];
  let h = 0;
  for (let i = 0; i < (nome || "").length; i++) h = (h * 31 + nome.charCodeAt(i)) & 0xffff;
  return colors[h % colors.length];
}

function contactStatusClass(s) {
  const map = { ativo: "ct-status-ativo", inativo: "ct-status-inativo", bloqueado: "ct-status-bloqueado" };
  return map[s] || "ct-status-inativo";
}

function contactStatusLabel(s) {
  const map = { ativo: "Ativo", inativo: "Inativo", bloqueado: "Bloqueado" };
  return map[s] || s;
}

// ── Load & Render ─────────────────────────────────────────────────────────────

async function loadContacts(silent = false) {
  const tbody = document.getElementById("contacts-tbody");
  if (!tbody) return;

  if (!silent) tbody.innerHTML = `<tr><td colspan="9" class="contacts-empty"><i class="fa-solid fa-spinner fa-spin"></i><br>Carregando...</td></tr>`;

  try {
    const params = new URLSearchParams({
      page:   _contactsPage,
      limit:  _contactsLimit,
      search: _contactsSearch,
      status: _contactsStatus,
      tag:    _contactsTag
    });

    const res  = await apiFetch(`/api/contacts?${params}`);
    const data = await res.json();

    _contactsTotal = data.total || 0;
    renderContactsTable(data.rows || []);
    renderContactsFooter();
    updateContactsBulkBar();
    document.getElementById("contacts-count-badge").textContent = _contactsTotal;
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="contacts-empty"><i class="fa-solid fa-triangle-exclamation"></i><br>Erro ao carregar contatos.</td></tr>`;
  }
}

function renderContactsTable(rows) {
  const tbody = document.getElementById("contacts-tbody");
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="contacts-empty"><i class="fa-solid fa-users-slash"></i>Nenhum contato encontrado.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(c => {
    const ini      = contactInitials(c.nome);
    const color    = contactAvatarColor(c.nome);
    const userId   = c.whatsapp.replace(/\D/g, "") + "@s.whatsapp.net";
    const photoUrl = `/api/contacts/photo?userId=${encodeURIComponent(userId)}`;
    const tags     = (c.tags || []).map(t => `<span class="ct-tag">${safe(t)}</span>`).join("");
    const checked  = _contactsSelected.has(c.id) ? "checked" : "";

    return `
    <tr class="${_contactsSelected.has(c.id) ? "ct-selected" : ""}" data-id="${escapeAttr(c.id)}">
      <td><input type="checkbox" class="ct-check" data-id="${escapeAttr(c.id)}" ${checked} onchange="toggleContactSelect('${escapeAttr(c.id)}', this.checked)"></td>
      <td>
        <div class="ct-nome-cell">
          <div class="ct-avatar-wrap" style="position:relative;width:36px;height:36px;flex-shrink:0;">
            <div class="ct-avatar-ini" style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:12px;position:absolute;inset:0;">${ini}</div>
            <img class="ct-avatar-img" src="${photoUrl}"
              style="width:36px;height:36px;border-radius:50%;object-fit:cover;position:absolute;inset:0;display:none;"
              onload="this.style.display='block'"
              onerror="this.style.display='none'">
          </div>
          <div>
            <strong>${safe(c.nome)}</strong>
            ${c.departamento ? `<span>${safe(c.departamento)}</span>` : ""}
          </div>
        </div>
      </td>
      <td style="white-space:nowrap;">${safe(formatContactPhone(c.whatsapp))}</td>
      <td>${safe(c.estado || "—")}</td>
      <td><span class="ct-status ${contactStatusClass(c.status)}">${contactStatusLabel(c.status)}</span></td>
      <td><div class="ct-tags">${tags || '<span style="color:var(--muted);font-size:12px;">—</span>'}</div></td>
      <td>${safe(c.atendente_nome || "—")}</td>
      <td>${safe(c.departamento || "—")}</td>
      <td>
        <div class="ct-actions">
          <button class="ct-btn ct-btn-msg" title="Enviar mensagem" onclick="contactSendMsg('${escapeAttr(c.whatsapp)}','${escapeAttr(c.nome)}')">
            <i class="fa-solid fa-message"></i>
          </button>
          <button class="ct-btn ct-btn-edit" title="Editar" onclick="openContactModal('${escapeAttr(c.id)}')">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="ct-btn ct-btn-delete" title="Excluir" onclick="confirmDeleteContact('${escapeAttr(c.id)}','${escapeAttr(c.nome)}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

function renderContactsFooter() {
  const showing = document.getElementById("contacts-showing");
  const pagInfo = document.getElementById("contacts-page-info");
  const btnPrev = document.getElementById("contacts-prev");
  const btnNext = document.getElementById("contacts-next");

  const totalPages = Math.max(1, Math.ceil(_contactsTotal / _contactsLimit));
  const start = (_contactsPage - 1) * _contactsLimit + 1;
  const end   = Math.min(_contactsPage * _contactsLimit, _contactsTotal);

  if (showing) showing.textContent = _contactsTotal > 0 ? `${start}–${end} de ${_contactsTotal} contatos` : "0 contatos";
  if (pagInfo) pagInfo.textContent = `${_contactsPage} / ${totalPages}`;
  if (btnPrev) btnPrev.disabled = _contactsPage <= 1;
  if (btnNext) btnNext.disabled = _contactsPage >= totalPages;
}

// ── Selection ─────────────────────────────────────────────────────────────────

function toggleContactSelectAll(checked) {
  document.querySelectorAll(".ct-check").forEach(cb => {
    const id = cb.dataset.id;
    if (checked) _contactsSelected.add(id);
    else _contactsSelected.delete(id);
    cb.checked = checked;
    cb.closest("tr")?.classList.toggle("ct-selected", checked);
  });
  updateContactsBulkBar();
}

function toggleContactSelect(id, checked) {
  if (checked) _contactsSelected.add(id);
  else _contactsSelected.delete(id);
  document.querySelector(`tr[data-id="${id}"]`)?.classList.toggle("ct-selected", checked);
  updateContactsBulkBar();
}

function updateContactsBulkBar() {
  const bar = document.getElementById("contacts-bulk-bar");
  const lbl = document.getElementById("contacts-bulk-label");
  if (!bar) return;
  const n = _contactsSelected.size;
  bar.classList.toggle("visible", n > 0);
  if (lbl) lbl.textContent = `${n} contato${n !== 1 ? "s" : ""} selecionado${n !== 1 ? "s" : ""}`;
}

async function bulkDeleteContacts() {
  const ids = [..._contactsSelected];
  if (!ids.length) return;
  if (!confirm(`Excluir ${ids.length} contato(s)? Esta ação não pode ser desfeita.`)) return;
  try {
    const res  = await apiFetch("/api/contacts/bulk", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _contactsSelected.clear();
    showToast(`${data.deleted} contato(s) excluído(s).`);
    loadContacts();
  } catch (e) {
    showToast("Erro ao excluir: " + e.message, "error");
  }
}

// ── Filters & Search ──────────────────────────────────────────────────────────

function contactsSearch(val) {
  _contactsSearch = val.trim();
  _contactsPage   = 1;
  clearTimeout(_contactsPollTimer);
  _contactsPollTimer = setTimeout(() => loadContacts(), 350);
}

function contactsFilterStatus(val) {
  _contactsStatus = val;
  _contactsPage   = 1;
  loadContacts();
}

function contactsFilterTag(val) {
  _contactsTag  = val;
  _contactsPage = 1;
  loadContacts();
}

function contactsPagePrev() {
  if (_contactsPage > 1) { _contactsPage--; loadContacts(); }
}

function contactsPageNext() {
  const total = Math.ceil(_contactsTotal / _contactsLimit);
  if (_contactsPage < total) { _contactsPage++; loadContacts(); }
}

// ── Tags dropdown population ──────────────────────────────────────────────────

async function loadContactsTags() {
  try {
    const tags = await apiFetch("/api/contacts/tags").then(r => r.json());
    const sel  = document.getElementById("contacts-filter-tag");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">Todas as etiquetas</option>` +
      tags.map(t => `<option value="${escapeAttr(t)}" ${t === current ? "selected" : ""}>${safe(t)}</option>`).join("");
  } catch (_) {}
}

// ── Add/Edit Modal ────────────────────────────────────────────────────────────

async function openContactModal(id = null) {
  _contactsEditingId = id;
  const overlay = document.getElementById("contact-modal-overlay");
  const title   = document.getElementById("contact-modal-title");
  if (!overlay) return;

  // Reset form
  ["contact-nome","contact-whatsapp","contact-estado","contact-status",
   "contact-departamento","contact-atendente","contact-tags"].forEach(f => {
    const el = document.getElementById(f);
    if (el) el.value = "";
  });

  if (id) {
    title.textContent = "Editar Contato";
    try {
      const data = await apiFetch(`/api/contacts/${id}`).then(r => r.json());
      if (data.error) throw new Error(data.error);
      document.getElementById("contact-nome").value        = data.nome || "";
      document.getElementById("contact-whatsapp").value   = data.whatsapp || "";
      document.getElementById("contact-estado").value     = data.estado || "";
      document.getElementById("contact-status").value     = data.status || "ativo";
      document.getElementById("contact-departamento").value = data.departamento || "";
      document.getElementById("contact-atendente").value  = data.atendente_id || "";
      document.getElementById("contact-tags").value       = (data.tags || []).join(", ");
    } catch (e) {
      showToast("Erro ao carregar contato.", "error");
      return;
    }
  } else {
    title.textContent = "Novo Contato";
    document.getElementById("contact-status").value = "ativo";
  }

  overlay.classList.remove("hidden");
}

function closeContactModal() {
  document.getElementById("contact-modal-overlay")?.classList.add("hidden");
  _contactsEditingId = null;
}

async function saveContact() {
  const nome        = document.getElementById("contact-nome").value.trim();
  const whatsapp    = document.getElementById("contact-whatsapp").value.trim();
  const estado      = document.getElementById("contact-estado").value;
  const status      = document.getElementById("contact-status").value;
  const departamento= document.getElementById("contact-departamento").value.trim();
  const atendenteId = document.getElementById("contact-atendente").value;
  const tagsRaw     = document.getElementById("contact-tags").value;
  const tags        = tagsRaw.split(",").map(t => t.trim()).filter(Boolean);

  if (!nome || !whatsapp) { showToast("Nome e WhatsApp são obrigatórios.", "error"); return; }

  const payload = { nome, whatsapp, estado, status, departamento, atendenteId, tags };
  const url     = _contactsEditingId ? `/api/contacts/${_contactsEditingId}` : "/api/contacts";
  const method  = _contactsEditingId ? "PUT" : "POST";

  try {
    const data = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    closeContactModal();
    showToast(_contactsEditingId ? "Contato atualizado." : "Contato criado.");
    loadContacts();
    loadContactsTags();
  } catch (e) {
    showToast("Erro: " + e.message, "error");
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────────

function confirmDeleteContact(id, nome) {
  const overlay = document.getElementById("contact-delete-overlay");
  const lbl     = document.getElementById("contact-delete-name");
  if (!overlay) return;
  if (lbl) lbl.textContent = nome;
  overlay.dataset.deleteId = id;
  overlay.classList.remove("hidden");
}

function closeDeleteContactModal() {
  document.getElementById("contact-delete-overlay")?.classList.add("hidden");
}

async function doDeleteContact() {
  const overlay = document.getElementById("contact-delete-overlay");
  const id = overlay?.dataset.deleteId;
  if (!id) return;
  try {
    const data = await apiFetch(`/api/contacts/${id}`, { method: "DELETE" }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    closeDeleteContactModal();
    showToast("Contato excluído.");
    loadContacts();
  } catch (e) {
    showToast("Erro: " + e.message, "error");
  }
}

// ── Import / Export ───────────────────────────────────────────────────────────

function importContactsCSV() {
  const input = document.createElement("input");
  input.type  = "file";
  input.accept = ".csv,text/csv";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await apiFetch("/api/contacts/import", { method: "POST", body: fd }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      showToast(`${data.inserted} importados, ${data.skipped} ignorados.`);
      loadContacts();
      loadContactsTags();
    } catch (e) {
      showToast("Erro na importação: " + e.message, "error");
    }
  };
  input.click();
}

async function exportContactsCSV() {
  try {
    const res = await fetch("/api/contacts/export", { credentials: "include" });
    if (!res.ok) throw new Error("Erro ao exportar");
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "contatos.csv";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast("Erro ao exportar contatos.", "error");
  }
}

// ── Send message shortcut ─────────────────────────────────────────────────────

function contactSendMsg(whatsapp, nome) {
  const modal = document.getElementById("chat-modal");
  if (!modal) return;
  const userEl = document.getElementById("chat-user");
  if (userEl) userEl.textContent = nome;
  // Pre-fill the whatsapp target used by enviarMensagemManual if it reads from chat-user
  modal.dataset.whatsapp = whatsapp;
  modal.classList.remove("hidden");
}

// ── Load users for atendente dropdown ────────────────────────────────────────

async function loadContactsAtendenteOptions() {
  try {
    const users = await apiFetch("/api/users").then(r => r.json());
    const sel   = document.getElementById("contact-atendente");
    if (!sel) return;
    sel.innerHTML = `<option value="">Nenhum</option>` +
      (users.rows || users).map(u =>
        `<option value="${escapeAttr(u.id)}">${safe(u.nome)}</option>`
      ).join("");
  } catch (_) {}
}
