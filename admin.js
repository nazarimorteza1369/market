(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  let adminKey = (params.get("key") || "").trim();

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function loadSummary() {
    const data = await window.GazinAPI.adminGetSummary(adminKey);

    $("admin-auth-panel").classList.add("hidden");
    $("admin-content").classList.remove("hidden");

    const c = data.counts;
    $("kpi-completed").textContent = c.completed_sessions;
    $("kpi-total").textContent = c.total_sessions;
    $("kpi-split").textContent = `${c.human_completed} / ${c.agent_completed}`;
    $("kpi-attention").textContent =
      c.attention_pass_rate === null ? "—" : `${(c.attention_pass_rate * 100).toFixed(1)}%`;
    $("kpi-choices").textContent = c.total_choices;

    const cellsBody = $("cells-tbody");
    cellsBody.innerHTML = "";
    data.cells.forEach((cell) => {
      const tr = document.createElement("tr");
      const rateStr =
        cell.small_choice_rate === null ? "—" : `${(cell.small_choice_rate * 100).toFixed(1)}%`;
      const hhi01Str = cell.hhi_0_1 === null ? "—" : Number(cell.hhi_0_1).toFixed(4);
      const hhi10kStr = cell.hhi_10000 === null ? "—" : cell.hhi_10000;
      const inspStr = cell.avg_inspected_offers === null ? "—" : cell.avg_inspected_offers;

      tr.innerHTML = `
        <td><strong>${cell.decision_maker === "agent" ? "AI Agent (1)" : "Human (0)"}</strong></td>
        <td>${cell.policy_condition === "diversity" ? "Diversity Guarantee (1)" : "Popularity (0)"}</td>
        <td>${cell.n_choices}</td>
        <td><strong>${rateStr}</strong></td>
        <td>${hhi01Str}</td>
        <td>${hhi10kStr}</td>
        <td>${inspStr}</td>
      `;
      cellsBody.appendChild(tr);
    });

    const recBody = $("recent-tbody");
    recBody.innerHTML = "";
    data.recent_sessions.forEach((s) => {
      const tr = document.createElement("tr");
      const attBadge =
        s.decision_maker === "agent"
          ? "N/A"
          : s.passed_attention_check === 1
          ? "Passed"
          : s.passed_attention_check === 0
          ? "Failed"
          : "Pending";
      tr.innerHTML = `
        <td><code>${escapeHtml(s.participant_code)}</code></td>
        <td>${escapeHtml(s.decision_maker)}</td>
        <td>${escapeHtml(s.ai_model || "—")}</td>
        <td>${escapeHtml(s.policy_condition)}</td>
        <td>${s.choices_count} / 4</td>
        <td>${s.completed ? "Completed" : "In Progress"}</td>
        <td>${attBadge}</td>
        <td>${escapeHtml(s.created_at)}</td>
      `;
      recBody.appendChild(tr);
    });

    updateLinkBuilders();
  }

  function updateLinkBuilders() {
    const baseUrl = window.location.href.split("?")[0].replace(/\/admin(\.html)?$/i, "").replace(/\/+$/, "");
    $("url-human").textContent = `${baseUrl}/?type=human&lang=en`;
    $("url-human-fa").textContent = `${baseUrl}/?type=human&lang=fa`;
    $("url-prolific").textContent = `${baseUrl}/?type=human&lang=en&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}`;

    const model = ($("builder-model").value || "gpt-4o").trim();
    const policy = $("builder-policy").value;
    const runId = ($("builder-run").value || "01").trim();

    let url = `${baseUrl}/?type=agent&model=${encodeURIComponent(model)}&run_id=${encodeURIComponent(runId)}`;
    if (policy) {
      url += `&policy=${encodeURIComponent(policy)}`;
    }
    $("url-agent").textContent = url;
  }

  $("admin-auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("admin-auth-error");
    err.classList.add("hidden");
    adminKey = $("admin-key-input").value.trim();
    try {
      await loadSummary();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    }
  });

  $("btn-refresh-admin").addEventListener("click", () => {
    loadSummary().catch((ex) => alert(ex.message));
  });

  $("btn-delete-test").addEventListener("click", async () => {
    if (!confirm("Delete all sessions whose participant_code starts with TEST?")) return;
    try {
      const data = await window.GazinAPI.adminDeleteTest(adminKey);
      alert(`Deleted ${data.deleted_sessions} test session(s).`);
      loadSummary();
    } catch (ex) {
      alert(ex.message || "Delete failed");
    }
  });

  document.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const file = btn.getAttribute("data-export");
      window.GazinAPI.adminDownloadCsv(adminKey, file).catch((ex) => alert(ex.message));
    });
  });

  ["builder-model", "builder-policy", "builder-run"].forEach((id) => {
    $(id).addEventListener("input", updateLinkBuilders);
    $(id).addEventListener("change", updateLinkBuilders);
  });

  $("btn-copy-agent-url").addEventListener("click", () => {
    const txt = $("url-agent").textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(() => {
        $("btn-copy-agent-url").textContent = "Copied!";
        setTimeout(() => { $("btn-copy-agent-url").textContent = "Copy Agent URL"; }, 1800);
      });
    }
  });

  if (adminKey) {
    loadSummary().catch(() => {
      $("admin-auth-panel").classList.remove("hidden");
    });
  }
})();
