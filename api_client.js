(function () {
  "use strict";

  const cfg = window.GAZIN_CONFIG || {};
  const SUPABASE_URL = (cfg.supabaseUrl || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  const SUPABASE_ANON_KEY = (cfg.supabaseAnonKey || "").trim();
  const IS_CLOUD = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  // In-memory inspection tracker for cloud mode
  const cloudInspected = {};
  const cloudShownOffers = {};

  function uuidHex() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID().replace(/-/g, "");
    }
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  // Assign counterbalanced 2 popularity + 2 diversity (1 low + 1 high each) in randomized order
  function assignScenarioPolicies(scenarios, policyOverride) {
    if (policyOverride === "popularity" || policyOverride === "diversity") {
      return shuffle(scenarios).map((sc) => ({
        scenario: sc,
        policy: policyOverride
      }));
    }
    const low = shuffle(scenarios.filter((s) => s.involvement === "low"));
    const high = shuffle(scenarios.filter((s) => s.involvement === "high"));
    const paired = [];
    low.forEach((sc, idx) => paired.push({ scenario: sc, policy: idx % 2 === 0 ? "popularity" : "diversity" }));
    high.forEach((sc, idx) => paired.push({ scenario: sc, policy: idx % 2 === 0 ? "popularity" : "diversity" }));
    return shuffle(paired);
  }

  function buildScenarioOffers(scenario, policyCondition) {
    const largeList = shuffle(scenario.sellers.filter((s) => s.seller_size === "large"));
    const smallList = shuffle(scenario.sellers.filter((s) => s.seller_size === "small"));

    if (policyCondition === "popularity") {
      return {
        ordered: [largeList[0], largeList[1], largeList[2], smallList[0], smallList[1], smallList[2]],
        smallTop3Pos: null
      };
    }
    const qualifiedSmall = shuffle(smallList.filter((s) => s.seller_rating >= 4.7));
    const promotedSmall = qualifiedSmall.length > 0 ? qualifiedSmall[0] : smallList[0];
    const remainingSmall = shuffle(smallList.filter((s) => s.offer_id !== promotedSmall.offer_id));
    const pos = Math.floor(Math.random() * 2) + 1; // 1 or 2
    const top3 = [largeList[0], largeList[1], largeList[2]];
    const topPart = top3.slice(0, pos - 1).concat([promotedSmall], top3.slice(pos - 1));
    return {
      ordered: topPart.concat([remainingSmall[0], remainingSmall[1]]),
      smallTop3Pos: pos
    };
  }

  async function postLocalJson(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function supaReq(path, method, key, body, extraHeaders) {
    const baseHeaders = {
      apikey: key,
      "Content-Type": "application/json"
    };
    if (key && key.startsWith("eyJ")) {
      baseHeaders.Authorization = "Bearer " + key;
    }
    const headers = Object.assign(baseHeaders, extraHeaders || {});
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const txt = await res.text();
    if (!res.ok) {
      let msg = txt || `HTTP ${res.status}`;
      try {
        const j = JSON.parse(txt);
        msg = j.message || j.error || msg;
      } catch {}
      throw new Error(msg);
    }
    return txt ? JSON.parse(txt) : null;
  }

  function escapeCsv(val) {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function triggerCsvDownload(filename, headers, rows) {
    const lines = [headers.map(escapeCsv).join(",")];
    rows.forEach((r) => lines.push(r.map(escapeCsv).join(",")));
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function extractLanguage(studyId) {
    return String(studyId || "").toLowerCase().includes("lang=fa") ? "fa" : "en";
  }

  function computeHHI(sellerIds) {
    const n = sellerIds.length;
    if (n === 0) return { hhi01: null, hhi10k: null };
    const counts = {};
    sellerIds.forEach((sid) => {
      counts[sid] = (counts[sid] || 0) + 1;
    });
    let sumSq = 0;
    Object.values(counts).forEach((c) => {
      const share = c / n;
      sumSq += share * share;
    });
    return {
      hhi01: Number(sumSq.toFixed(4)),
      hhi10k: Math.round(sumSq * 10000)
    };
  }

  const GazinAPI = {
    isCloudMode: IS_CLOUD,

    async startSession(payload) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/session/start", payload);
      }

      const studyRes = await fetch("./scenarios_data.json");
      if (!studyRes.ok) throw new Error("Failed to load scenarios_data.json");
      const studyData = await studyRes.json();

      const dm = payload.decision_maker === "agent" ? "agent" : "human";
      const isAgent = dm === "agent" ? 1 : 0;
      const aiModel = isAgent ? (payload.ai_model || "").trim() : "";
      const prolificPid = (payload.prolific_pid || "").trim();
      const studyId = (payload.study_id || "").trim();
      const sessionId = uuidHex();
      const pCode =
        (payload.participant_code || "").trim() ||
        prolificPid ||
        (isAgent ? `AGENT-${sessionId.slice(0, 6).toUpperCase()}` : `H-${sessionId.slice(0, 6).toUpperCase()}`);

      const polOverride = (payload.policy_override || "").trim().toLowerCase();
      const sessionPolicy =
        polOverride === "popularity" || polOverride === "diversity" ? polOverride : "within_mixed";
      const sessionIsDiverse =
        sessionPolicy === "diversity" ? 1 : sessionPolicy === "popularity" ? 0 : null;

      const assigned = assignScenarioPolicies(studyData.scenarios, polOverride);
      const scenarioOrder = assigned.map((a) => `${a.scenario.scenario_id}:${a.policy}`);

      await supaReq("sessions", "POST", SUPABASE_ANON_KEY, {
        session_id: sessionId,
        participant_code: pCode,
        prolific_pid: prolificPid,
        study_id: studyId,
        decision_maker: dm,
        is_agent: isAgent,
        ai_model: aiModel,
        policy_condition: sessionPolicy,
        is_diverse: sessionIsDiverse,
        scenario_order_json: JSON.stringify(scenarioOrder),
        completed: 0
      });

      const shownRows = [];
      const clientScenarios = [];

      assigned.forEach((item, i) => {
        const sc = item.scenario;
        const scPolicy = item.policy;
        const scIsDiverse = scPolicy === "diversity" ? 1 : 0;
        const scIndex = i + 1;
        const { ordered, smallTop3Pos } = buildScenarioOffers(sc, scPolicy);

        const clientOffers = ordered.map((sel, rIdx) => {
          const rank = rIdx + 1;
          const isSmall = sel.seller_size === "small" ? 1 : 0;
          const row = {
            session_id: sessionId,
            scenario_index: scIndex,
            scenario_id: sc.scenario_id,
            product_involvement: sc.involvement,
            policy_condition: scPolicy,
            is_diverse: scIsDiverse,
            offer_id: sel.offer_id,
            seller_id: sel.seller_id,
            seller_name: sel.seller_name,
            seller_size: sel.seller_size,
            is_small_seller: isSmall,
            active_products: sel.active_products,
            seller_rating: sel.seller_rating,
            seller_review_count: sel.seller_review_count,
            years_active: sel.tenure_months,
            price_usd: sc.price_usd,
            display_rank: rank,
            small_top3_position: smallTop3Pos
          };
          shownRows.push(row);
          cloudShownOffers[`${sessionId}|${scIndex}|${sel.offer_id}`] = row;
          return Object.assign({}, sel, { display_rank: rank });
        });

        clientScenarios.push({
          scenario_index: scIndex,
          scenario_id: sc.scenario_id,
          category: sc.category,
          involvement: sc.involvement,
          policy_condition: scPolicy,
          is_diverse: scIsDiverse,
          product_title: sc.product_title,
          image_url: sc.image_url,
          price_usd: sc.price_usd,
          product_rating: sc.product_rating,
          product_review_count: sc.product_review_count,
          short_specs: sc.short_specs,
          full_description: sc.full_description,
          warranty: sc.warranty,
          delivery_text: sc.delivery_text,
          return_policy: sc.return_policy,
          availability: sc.availability,
          prompt: sc.prompt,
          offers: clientOffers
        });
      });

      await supaReq("shown_offers", "POST", SUPABASE_ANON_KEY, shownRows);

      return {
        session_id: sessionId,
        participant_code: pCode,
        decision_maker: dm,
        is_agent: isAgent,
        policy_condition: sessionPolicy,
        is_diverse: sessionIsDiverse,
        scenarios: clientScenarios
      };
    },

    logEvent(payload) {
      if (!IS_CLOUD) {
        fetch("/api/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(() => {});
        return;
      }

      if (
        (payload.event_type === "offer_detail_opened" || payload.event_type === "seller_profile_opened") &&
        payload.offer_id
      ) {
        const key = `${payload.session_id}|${payload.scenario_index}`;
        if (!cloudInspected[key]) cloudInspected[key] = {};
        cloudInspected[key][payload.offer_id] = payload.seller_size || "";
      }

      supaReq("events", "POST", SUPABASE_ANON_KEY, {
        session_id: payload.session_id,
        scenario_index: payload.scenario_index,
        scenario_id: payload.scenario_id,
        policy_condition: payload.policy_condition || "",
        is_diverse: payload.is_diverse != null ? payload.is_diverse : null,
        event_type: payload.event_type,
        offer_id: payload.offer_id || "",
        seller_id: payload.seller_id || "",
        seller_size: payload.seller_size || "",
        display_rank: payload.display_rank != null ? payload.display_rank : null,
        duration_ms: payload.duration_ms || 0
      }).catch(() => {});
    },

    async submitChoice(payload) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/choice", payload);
      }

      const offerRow = cloudShownOffers[`${payload.session_id}|${payload.scenario_index}|${payload.offer_id}`];
      if (!offerRow) throw new Error("Offer metadata not found");

      const inspMap = cloudInspected[`${payload.session_id}|${payload.scenario_index}`] || {};
      const inspVals = Object.values(inspMap);
      const inspCount = inspVals.length;
      const inspSmall = inspVals.filter((v) => v === "small").length;
      const inspLarge = inspVals.filter((v) => v === "large").length;

      await supaReq("choices", "POST", SUPABASE_ANON_KEY, {
        session_id: payload.session_id,
        scenario_index: payload.scenario_index,
        scenario_id: offerRow.scenario_id,
        product_involvement: offerRow.product_involvement,
        policy_condition: offerRow.policy_condition,
        is_diverse: offerRow.is_diverse,
        offer_id: offerRow.offer_id,
        chosen_seller_id: offerRow.seller_id,
        chosen_seller_name: offerRow.seller_name,
        chose_small: offerRow.is_small_seller,
        chosen_seller_size: offerRow.seller_size,
        chosen_active_products: offerRow.active_products,
        chosen_seller_rating: offerRow.seller_rating,
        chosen_seller_review_count: offerRow.seller_review_count,
        chosen_years_active: offerRow.years_active,
        chosen_rank: offerRow.display_rank,
        small_top3_position: offerRow.small_top3_position,
        inspected_count: inspCount,
        inspected_small: inspSmall,
        inspected_large: inspLarge,
        decision_time_ms: payload.decision_time_ms || 0
      });

      return { ok: true };
    },

    async submitSurvey(payload) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/survey", payload);
      }
      const passedAtt = (payload.attention_answer || "").toLowerCase() === "strongly_disagree" ? 1 : 0;
      const code = "GAZIN-2026-COMPLETE";
      await supaReq(`sessions?session_id=eq.${encodeURIComponent(payload.session_id)}`, "PATCH", SUPABASE_ANON_KEY, {
        completed: 1,
        passed_attention_check: passedAtt,
        attention_answer: payload.attention_answer || "",
        noticed_seller_size: payload.noticed_seller_size || "",
        size_influence_rating: payload.size_influence_rating ? Number(payload.size_influence_rating) : null,
        decision_rationale: payload.decision_rationale || "",
        age_group: payload.age_group || "",
        shopping_frequency: payload.shopping_frequency || "",
        completion_code: code,
        completed_at: new Date().toISOString()
      });
      return { ok: true, passed_attention_check: passedAtt, completion_code: code };
    },

    async completeAgentSession(sessionId) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/session/complete", { session_id: sessionId });
      }
      const code = "AGENT-RUN-COMPLETE";
      await supaReq(`sessions?session_id=eq.${encodeURIComponent(sessionId)}`, "PATCH", SUPABASE_ANON_KEY, {
        completed: 1,
        completion_code: code,
        completed_at: new Date().toISOString()
      });
      return { ok: true, completion_code: code };
    },

    // --- Admin helpers ---
    async adminFetchAllCloud(serviceKey) {
      const [sessions, choices, shownOffers, events] = await Promise.all([
        supaReq("sessions?select=*&order=created_at.desc&limit=5000", "GET", serviceKey),
        supaReq("choices?select=*&order=created_at.asc&limit=20000", "GET", serviceKey),
        supaReq("shown_offers?select=*&order=id.asc&limit=50000", "GET", serviceKey),
        supaReq("events?select=*&order=event_id.asc&limit=50000", "GET", serviceKey)
      ]);
      return { sessions: sessions || [], choices: choices || [], shownOffers: shownOffers || [], events: events || [] };
    },

    async adminGetSummary(adminKey) {
      if (!IS_CLOUD) {
        const res = await fetch(`/api/admin/summary?key=${encodeURIComponent(adminKey)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unauthorized");
        return data;
      }

      const { sessions, choices } = await this.adminFetchAllCloud(adminKey);
      const sessMap = {};
      sessions.forEach((s) => (sessMap[s.session_id] = s));

      const completed = sessions.filter((s) => s.completed === 1);
      const humanComp = completed.filter((s) => s.is_agent === 0).length;
      const agentComp = completed.filter((s) => s.is_agent === 1).length;
      const attRows = completed.filter((s) => s.is_agent === 0 && s.passed_attention_check !== null);
      const attRate =
        attRows.length > 0
          ? Number((attRows.reduce((acc, r) => acc + r.passed_attention_check, 0) / attRows.length).toFixed(4))
          : null;

      const cells = [];
      [
        ["human", 0],
        ["agent", 1]
      ].forEach(([dm, isA]) => {
        [
          ["popularity", 0],
          ["diversity", 1]
        ].forEach(([pol, isD]) => {
          const cRows = choices.filter((c) => {
            const s = sessMap[c.session_id];
            if (!s || s.is_agent !== isA) return false;
            const rowIsDiv = c.is_diverse !== null && c.is_diverse !== undefined ? c.is_diverse : s.is_diverse;
            return rowIsDiv === isD;
          });
          const n = cRows.length;
          const smallRate = n > 0 ? Number((cRows.reduce((a, r) => a + r.chose_small, 0) / n).toFixed(4)) : null;
          const avgInsp = n > 0 ? Number((cRows.reduce((a, r) => a + r.inspected_count, 0) / n).toFixed(2)) : null;
          const hhi = computeHHI(cRows.map((r) => r.chosen_seller_id));
          cells.push({
            decision_maker: dm,
            is_agent: isA,
            policy_condition: pol,
            is_diverse: isD,
            n_choices: n,
            small_choice_rate: smallRate,
            hhi_0_1: hhi.hhi01,
            hhi_10000: hhi.hhi10k,
            avg_inspected_offers: avgInsp
          });
        });
      });

      const choiceCounts = {};
      choices.forEach((c) => (choiceCounts[c.session_id] = (choiceCounts[c.session_id] || 0) + 1));

      return {
        counts: {
          total_sessions: sessions.length,
          completed_sessions: completed.length,
          human_completed: humanComp,
          agent_completed: agentComp,
          total_choices: choices.length,
          attention_pass_rate: attRate
        },
        cells,
        recent_sessions: sessions.slice(0, 30).map((s) => Object.assign({}, s, { choices_count: choiceCounts[s.session_id] || 0 }))
      };
    },

    async adminDownloadCsv(adminKey, fileType) {
      if (!IS_CLOUD) {
        window.location.href = `/api/admin/export/${fileType}?key=${encodeURIComponent(adminKey)}`;
        return;
      }

      const { sessions, choices, shownOffers, events } = await this.adminFetchAllCloud(adminKey);
      const sessMap = {};
      sessions.forEach((s) => (sessMap[s.session_id] = s));

      if (fileType === "choices.csv") {
        const headers = [
          "session_id","participant_code","prolific_pid","language","is_agent","decision_maker","ai_model",
          "is_diverse","policy_condition","scenario_index","scenario_id","product_involvement",
          "chosen_seller_id","chosen_seller_name","chose_small","chosen_seller_size",
          "chosen_active_products","chosen_seller_rating","chosen_seller_review_count","chosen_tenure_months",
          "chosen_rank","small_top2_position","inspected_count","inspected_small","inspected_large",
          "decision_time_ms","passed_attention_check","noticed_seller_size","size_influence_rating","created_at"
        ];
        const rows = choices
          .filter((c) => sessMap[c.session_id])
          .map((c) => {
            const s = sessMap[c.session_id];
            const isDiv = c.is_diverse !== null && c.is_diverse !== undefined ? c.is_diverse : s.is_diverse;
            const polCond = c.policy_condition || s.policy_condition;
            return [
              c.session_id, s.participant_code, s.prolific_pid, extractLanguage(s.study_id), s.is_agent, s.decision_maker, s.ai_model,
              isDiv, polCond, c.scenario_index, c.scenario_id, c.product_involvement,
              c.chosen_seller_id, c.chosen_seller_name, c.chose_small, c.chosen_seller_size,
              c.chosen_active_products, c.chosen_seller_rating ?? "", c.chosen_seller_review_count ?? "", c.chosen_years_active ?? "",
              c.chosen_rank, c.small_top3_position ?? "", c.inspected_count, c.inspected_small, c.inspected_large,
              c.decision_time_ms, s.passed_attention_check ?? "", s.noticed_seller_size, s.size_influence_rating ?? "",
              c.created_at
            ];
          });
        triggerCsvDownload("choices_regression.csv", headers, rows);
      } else if (fileType === "offers_long.csv") {
        const headers = [
          "session_id","participant_code","is_agent","decision_maker","ai_model","is_diverse","policy_condition",
          "scenario_index","scenario_id","product_involvement","offer_id","seller_id","seller_name",
          "is_small_seller","seller_size","active_products","seller_rating","seller_review_count","tenure_months",
          "price_usd","display_rank","small_top3_position","was_inspected","chosen"
        ];
        const choiceLookup = {};
        choices.forEach((c) => (choiceLookup[`${c.session_id}|${c.scenario_index}`] = c.offer_id));
        const inspLookup = {};
        events.forEach((e) => {
          if (e.event_type === "offer_detail_opened" || e.event_type === "seller_profile_opened") {
            inspLookup[`${e.session_id}|${e.scenario_index}|${e.offer_id}`] = true;
          }
        });
        const rows = shownOffers
          .filter((o) => sessMap[o.session_id] && choiceLookup[`${o.session_id}|${o.scenario_index}`])
          .map((o) => {
            const s = sessMap[o.session_id];
            const k = `${o.session_id}|${o.scenario_index}`;
            const isDiv = o.is_diverse !== null && o.is_diverse !== undefined ? o.is_diverse : s.is_diverse;
            const polCond = o.policy_condition || s.policy_condition;
            return [
              o.session_id, s.participant_code, s.is_agent, s.decision_maker, s.ai_model,
              isDiv, polCond, o.scenario_index, o.scenario_id, o.product_involvement,
              o.offer_id, o.seller_id, o.seller_name, o.is_small_seller, o.seller_size, o.active_products,
              o.seller_rating, o.seller_review_count, o.years_active ?? "", o.price_usd, o.display_rank, o.small_top3_position ?? "",
              inspLookup[`${k}|${o.offer_id}`] ? 1 : 0,
              choiceLookup[k] === o.offer_id ? 1 : 0
            ];
          });
        triggerCsvDownload("offers_long_logit.csv", headers, rows);
      } else if (fileType === "events.csv") {
        const headers = [
          "event_id","session_id","participant_code","is_agent","is_diverse","scenario_index","scenario_id",
          "event_type","offer_id","seller_id","seller_size","display_rank","duration_ms","created_at"
        ];
        const rows = events
          .filter((e) => sessMap[e.session_id])
          .map((e) => {
            const s = sessMap[e.session_id];
            const isDiv = e.is_diverse !== null && e.is_diverse !== undefined ? e.is_diverse : s.is_diverse;
            return [
              e.event_id, e.session_id, s.participant_code, s.is_agent, isDiv ?? "",
              e.scenario_index, e.scenario_id, e.event_type, e.offer_id, e.seller_id, e.seller_size,
              e.display_rank ?? "", e.duration_ms, e.created_at
            ];
          });
        triggerCsvDownload("events.csv", headers, rows);
      } else if (fileType === "sessions.csv") {
        const headers = [
          "session_id","participant_code","prolific_pid","language","decision_maker","is_agent","ai_model",
          "policy_condition","is_diverse","completed","passed_attention_check","noticed_seller_size",
          "size_influence_rating","decision_rationale","age_group","shopping_frequency","created_at","completed_at"
        ];
        const rows = sessions.map((s) => [
          s.session_id, s.participant_code, s.prolific_pid, extractLanguage(s.study_id), s.decision_maker, s.is_agent, s.ai_model,
          s.policy_condition, s.is_diverse ?? "", s.completed, s.passed_attention_check ?? "", s.noticed_seller_size,
          s.size_influence_rating ?? "", s.decision_rationale, s.age_group, s.shopping_frequency,
          s.created_at, s.completed_at || ""
        ]);
        triggerCsvDownload("sessions.csv", headers, rows);
      }
    },

    async adminDeleteTest(adminKey) {
      if (!IS_CLOUD) {
        const res = await fetch(`/api/admin/delete-test?key=${encodeURIComponent(adminKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Delete failed");
        return data;
      }

      const deleted = await supaReq(
        "sessions?participant_code=ilike.TEST*",
        "DELETE",
        adminKey,
        undefined,
        { Prefer: "return=representation" }
      );
      return { ok: true, deleted_sessions: Array.isArray(deleted) ? deleted.length : 0 };
    }
  };

  window.GazinAPI = GazinAPI;
})();
