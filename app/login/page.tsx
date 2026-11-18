"use client";
import { useEffect, useState } from "react";
import { setLang, storedLang, t, useLang } from "@/components/i18n";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  useLang(); // re-render when the language switches
  useEffect(() => { setLang(storedLang(), false); }, []);
  return (
    <main className="login">
      <form
        className="login-box glass"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setErr(false);
          const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
          setBusy(false);
          if (r.ok) location.href = "/"; else setErr(true);
        }}
      >
        <div className="wordmark">Azymut</div>
        <label className="caps" htmlFor="pw">{t("Hasło")}</label>
        <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        <button type="submit" disabled={busy}>{busy ? "…" : t("Wejdź")}</button>
        {err && <div className="login-err">{t("nieprawidłowe hasło")}</div>}
      </form>
    </main>
  );
}
