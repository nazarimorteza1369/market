(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const rawType = (params.get("type") || "human").toLowerCase();
  const decisionMaker = rawType === "agent" ? "agent" : "human";
  const isAgent = decisionMaker === "agent";
  const prolificPid = (params.get("PROLIFIC_PID") || "").trim();
  const studyId = (params.get("STUDY_ID") || "").trim();
  const aiModel = (params.get("model") || (isAgent ? "unspecified-agent" : "")).trim();
  const runId = (params.get("run_id") || "").trim();
  const policyOverride = (params.get("policy") || "").trim().toLowerCase();
  const forceSurvey = params.get("survey") === "1";

  const state = {
    sessionId: null,
    participantCode: "",
    scenarios: [],
    currentIndex: 0,
    selectedOffer: null,
    scenarioStartMs: 0,
    activeModalOffer: null,
    activeModalType: null,
    modalOpenedMs: 0
  };

  const $ = (id) => document.getElementById(id);
  const appRoot = $("app-root");
  const views = {
    welcome: $("view-welcome"),
    consent: $("view-consent"),
    instructions: $("view-instructions"),
    marketplace: $("view-marketplace"),
    survey: $("view-survey"),
    complete: $("view-complete")
  };

  function showView(name) {
    Object.keys(views).forEach((k) => {
      views[k].classList.toggle("hidden", k !== name);
    });
    const showSticky = name === "marketplace";
    $("sticky-bar").classList.toggle("hidden", !showSticky);
    appRoot.setAttribute("data-study-status", name);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatUsd(val) {
    return "$" + Number(val).toFixed(2);
  }

  function formatInt(val) {
    return Number(val).toLocaleString("en-US");
  }

  function logEvent(eventType, offer, durationMs) {
    if (!state.sessionId) return;
    const sc = state.scenarios[state.currentIndex];
    if (!sc) return;
    window.GazinAPI.logEvent({
      session_id: state.sessionId,
      scenario_index: sc.scenario_index,
      scenario_id: sc.scenario_id,
      event_type: eventType,
      offer_id: offer ? offer.offer_id : "",
      seller_id: offer ? offer.seller_id : "",
      seller_group: offer ? offer.seller_group : "",
      display_rank: offer ? offer.display_rank : null,
      duration_ms: durationMs || 0
    });
  }

  const pInput = $("participant-code-input");
  if (prolificPid) {
    pInput.value = prolificPid;
  } else if (isAgent) {
    pInput.value = runId ? `${aiModel}-run-${runId}` : `${aiModel}-run`;
  }

  $("btn-to-consent").addEventListener("click", () => showView("consent"));
  $("btn-back-welcome").addEventListener("click", () => showView("welcome"));
  $("btn-back-consent").addEventListener("click", () => showView("consent"));

  $("consent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$("consent-checkbox").checked) return;
    state.participantCode = pInput.value.trim();
    showView("instructions");
  });

  $("btn-start-tasks").addEventListener("click", async () => {
    const btn = $("btn-start-tasks");
    const errBox = $("start-error");
    errBox.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Loading Study...";

    try {
      const data = await window.GazinAPI.startSession({
        participant_code: state.participantCode,
        prolific_pid: prolificPid,
        study_id: studyId,
        decision_maker: decisionMaker,
        ai_model: aiModel,
        policy_override: policyOverride
      });
      state.sessionId = data.session_id;
      state.participantCode = data.participant_code;
      state.scenarios = data.scenarios;
      state.currentIndex = 0;
      renderScenario();
      showView("marketplace");
    } catch (err) {
      errBox.textContent = "Could not start session: " + err.message;
      errBox.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Begin Shopping Tasks";
    }
  });

  function renderScenario() {
    const sc = state.scenarios[state.currentIndex];
    const total = state.scenarios.length;
    const pct = Math.round(((state.currentIndex + 1) / total) * 100);

    state.selectedOffer = null;
    state.scenarioStartMs = Date.now();

    $("header-breadcrumb").textContent = `Marketplace › ${sc.category} › ${sc.product_title}`;
    $("task-counter").textContent = `Task ${state.currentIndex + 1} of ${total}`;
    $("task-title").textContent = sc.product_title;
    $("task-prompt").textContent = sc.prompt;
    $("progress-pct").textContent = `${pct}%`;
    $("progress-fill").style.width = `${pct}%`;

    updateSelectionUI();

    const listEl = $("offers-list");
    listEl.innerHTML = "";

    sc.offers.forEach((offer) => {
      const card = document.createElement("article");
      card.className = "offer-card";
      card.setAttribute("data-offer-id", offer.offer_id);
      card.setAttribute("data-seller-id", offer.seller_id);

      card.innerHTML = `
        <div class="offer-img-box">
          <img src="${escapeHtml(sc.image_url)}" alt="${escapeHtml(sc.product_title)}" />
        </div>
        <div class="offer-body">
          <h2 class="offer-title">${escapeHtml(sc.product_title)}</h2>
          <div class="offer-specs">${escapeHtml(sc.short_specs)}</div>
          <div class="offer-rating-line">
            <span class="stars">&#9733; ${Number(sc.product_rating).toFixed(1)}</span>
            <span class="muted">(${formatInt(sc.product_review_count)} product reviews)</span>
            <span class="stock-pill">${escapeHtml(sc.availability)}</span>
          </div>
          <div class="price-info-box">
            <div class="price-tag">${formatUsd(offer.offer_price_usd)}</div>
            <div class="delivery-line">${escapeHtml(sc.delivery_text)}</div>
          </div>
        </div>
        <div class="offer-action-col">
          <div class="seller-info-box">
            <div class="seller-link-row">
              <span class="muted">Sold by</span>
              <button type="button" class="seller-name-btn" data-action="open-seller">${escapeHtml(offer.seller_name)}</button>
            </div>
            <div class="seller-rating-line">
              Seller rating: <span class="stars">${Number(offer.seller_rating).toFixed(1)} &#9733;</span> <span class="muted">(${formatInt(offer.seller_review_count)} ratings)</span>
            </div>
            <div class="seller-tenure-line">
              ${offer.years_active > 0 ? `${offer.years_active} years active` : "&lt;1 year active"}
            </div>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-offer">View Offer Details</button>
          <button type="button" class="select-offer-btn" data-action="select-offer" role="radio" aria-checked="false">Select This Offer</button>
        </div>
      `;

      card.querySelector('[data-action="open-seller"]').addEventListener("click", () => openSellerModal(offer, sc));
      card.querySelector('[data-action="open-offer"]').addEventListener("click", () => openOfferModal(offer, sc));
      card.querySelector('[data-action="select-offer"]').addEventListener("click", () => selectOffer(offer));

      listEl.appendChild(card);
    });

    logEvent("scenario_viewed", null, 0);
  }

  function selectOffer(offer) {
    state.selectedOffer = offer;
    updateSelectionUI();
    logEvent("offer_selected_radio", offer, 0);
  }

  function updateSelectionUI() {
    const cards = document.querySelectorAll(".offer-card");
    cards.forEach((card) => {
      const oid = card.getAttribute("data-offer-id");
      const isSelected = state.selectedOffer && state.selectedOffer.offer_id === oid;
      card.classList.toggle("selected", Boolean(isSelected));
      const btn = card.querySelector('[data-action="select-offer"]');
      if (btn) {
        btn.setAttribute("aria-checked", isSelected ? "true" : "false");
        btn.textContent = isSelected ? "Selected ✓" : "Select This Offer";
      }
    });

    const sc = state.scenarios[state.currentIndex];
    const stickyText = $("sticky-selection-text");
    const confirmBtn = $("btn-confirm-choice");

    if (state.selectedOffer && sc) {
      stickyText.innerHTML = `Selected: <strong>${escapeHtml(state.selectedOffer.seller_name)}</strong> — <strong>${formatUsd(state.selectedOffer.offer_price_usd)}</strong>`;
      confirmBtn.disabled = false;
    } else {
      stickyText.textContent = "Please select one offer above to continue.";
      confirmBtn.disabled = true;
    }
  }

  function openOfferModal(offer, sc) {
    state.activeModalOffer = offer;
    state.activeModalType = "offer";
    state.modalOpenedMs = Date.now();
    logEvent("offer_detail_opened", offer, 0);

    $("offer-modal-title").textContent = sc.product_title;
    $("offer-modal-content").innerHTML = `
      <div class="detail-grid">
        <div class="offer-img-box"><img src="${escapeHtml(sc.image_url)}" alt="${escapeHtml(sc.product_title)}" /></div>
        <div>
          <div class="price-tag">${formatUsd(offer.offer_price_usd)}</div>
          <p class="offer-rating-line">
            <span class="stars">&#9733; ${Number(sc.product_rating).toFixed(1)}</span>
            <span class="muted">(${formatInt(sc.product_review_count)} product reviews)</span>
          </p>
          <p class="small-note">${escapeHtml(sc.full_description)}</p>
        </div>
      </div>
      <table class="spec-table">
        <tr><th>Seller</th><td>${escapeHtml(offer.seller_name)} (${Number(offer.seller_rating).toFixed(1)} &#9733;, ${formatInt(offer.seller_review_count)} ratings)</td></tr>
        <tr><th>Time on Marketplace</th><td>${escapeHtml(offer.tenure_text)}</td></tr>
        <tr><th>Key Specifications</th><td>${escapeHtml(sc.short_specs)}</td></tr>
        <tr><th>Shipping</th><td>${escapeHtml(sc.delivery_text)}</td></tr>
        <tr><th>Warranty</th><td>${escapeHtml(sc.warranty)}</td></tr>
        <tr><th>Return Policy</th><td>${escapeHtml(sc.return_policy)}</td></tr>
        <tr><th>Availability</th><td>${escapeHtml(sc.availability)}</td></tr>
      </table>
    `;
    $("modal-offer").classList.remove("hidden");
  }

  function closeOfferModal() {
    if ($("modal-offer").classList.contains("hidden")) return;
    const dwell = Date.now() - state.modalOpenedMs;
    logEvent("offer_detail_closed", state.activeModalOffer, dwell);
    $("modal-offer").classList.add("hidden");
  }

  $("btn-close-offer").addEventListener("click", closeOfferModal);
  $("btn-offer-back").addEventListener("click", closeOfferModal);
  $("btn-offer-select").addEventListener("click", () => {
    if (state.activeModalOffer) selectOffer(state.activeModalOffer);
    closeOfferModal();
  });

  function openSellerModal(offer, sc) {
    state.activeModalOffer = offer;
    state.activeModalType = "seller";
    state.modalOpenedMs = Date.now();
    logEvent("seller_profile_opened", offer, 0);

    $("seller-modal-title").textContent = offer.seller_name;
    $("seller-modal-content").innerHTML = `
      <p class="muted">Verified storefront on Gazin Market &middot; ${escapeHtml(offer.on_time_rate)} on-time delivery</p>
      <div class="stat-cards-3">
        <div class="stat-tile">
          <div class="stat-val">${Number(offer.seller_rating).toFixed(1)} &#9733;</div>
          <div class="stat-lbl">Seller Star Rating</div>
        </div>
        <div class="stat-tile">
          <div class="stat-val">${formatInt(offer.seller_review_count)}</div>
          <div class="stat-lbl">Customer Ratings</div>
        </div>
        <div class="stat-tile">
          <div class="stat-val">${escapeHtml(offer.tenure_short.replace(" active", ""))}</div>
          <div class="stat-lbl">Marketplace Tenure</div>
        </div>
      </div>
      <table class="spec-table">
        <tr><th>Storefront History</th><td>${escapeHtml(offer.tenure_text)}</td></tr>
        <tr><th>Product Offered</th><td>${escapeHtml(sc.product_title)}</td></tr>
        <tr><th>Offer Price</th><td>${formatUsd(offer.offer_price_usd)}</td></tr>
        <tr><th>Shipping</th><td>${escapeHtml(sc.delivery_text)}</td></tr>
        <tr><th>Return Policy</th><td>${escapeHtml(sc.return_policy)}</td></tr>
      </table>
    `;
    $("modal-seller").classList.remove("hidden");
  }

  function closeSellerModal() {
    if ($("modal-seller").classList.contains("hidden")) return;
    const dwell = Date.now() - state.modalOpenedMs;
    logEvent("seller_profile_closed", state.activeModalOffer, dwell);
    $("modal-seller").classList.add("hidden");
  }

  $("btn-close-seller").addEventListener("click", closeSellerModal);
  $("btn-seller-back").addEventListener("click", closeSellerModal);
  $("btn-seller-select").addEventListener("click", () => {
    if (state.activeModalOffer) selectOffer(state.activeModalOffer);
    closeSellerModal();
  });

  $("btn-confirm-choice").addEventListener("click", () => {
    if (!state.selectedOffer) return;
    const sc = state.scenarios[state.currentIndex];
    $("confirm-modal-body").innerHTML = `You are selecting <strong>${escapeHtml(sc.product_title)}</strong> from seller <strong>${escapeHtml(state.selectedOffer.seller_name)}</strong> for <strong>${formatUsd(state.selectedOffer.offer_price_usd)}</strong>.`;
    $("modal-confirm").classList.remove("hidden");
  });

  $("btn-cancel-confirm").addEventListener("click", () => {
    $("modal-confirm").classList.add("hidden");
  });

  $("btn-submit-choice").addEventListener("click", async () => {
    if (!state.selectedOffer) return;
    const btn = $("btn-submit-choice");
    btn.disabled = true;
    btn.textContent = "Saving...";
    const sc = state.scenarios[state.currentIndex];
    const decisionTimeMs = Date.now() - state.scenarioStartMs;

    try {
      await window.GazinAPI.submitChoice({
        session_id: state.sessionId,
        scenario_index: sc.scenario_index,
        scenario_id: sc.scenario_id,
        offer_id: state.selectedOffer.offer_id,
        decision_time_ms: decisionTimeMs
      });
      $("modal-confirm").classList.add("hidden");

      if (state.currentIndex + 1 < state.scenarios.length) {
        state.currentIndex += 1;
        renderScenario();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (isAgent && !forceSurvey) {
        const res = await window.GazinAPI.completeAgentSession(state.sessionId);
        finishStudy(res.completion_code);
      } else {
        showView("survey");
      }
    } catch (err) {
      alert("Error saving selection: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Yes, Confirm Offer";
    }
  });

  $("survey-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = $("survey-error");
    errBox.classList.add("hidden");
    const btn = $("btn-submit-survey");
    btn.disabled = true;
    btn.textContent = "Submitting...";

    try {
      const res = await window.GazinAPI.submitSurvey({
        session_id: state.sessionId,
        attention_answer: $("attention-check").value,
        noticed_seller_history: $("noticed-history").value,
        history_influence_rating: $("history-influence").value,
        noticed_price_diff: $("noticed-price").value,
        decision_rationale: $("decision-rationale").value,
        age_group: $("age-group").value,
        shopping_frequency: $("shopping-freq").value
      });
      finishStudy(res.completion_code);
    } catch (err) {
      errBox.textContent = "Submission error: " + err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
      btn.textContent = "Submit Study";
    }
  });

  function finishStudy(code) {
    $("completion-code-text").textContent = code || "GAZIN-2026-COMPLETE";
    showView("complete");
    appRoot.setAttribute("data-study-status", "complete");
  }

  $("btn-copy-code").addEventListener("click", () => {
    const txt = $("completion-code-text").textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(() => {
        $("btn-copy-code").textContent = "Copied!";
        setTimeout(() => { $("btn-copy-code").textContent = "Copy Code"; }, 1800);
      });
    }
  });
})();
