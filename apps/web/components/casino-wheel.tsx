"use client";

import { useMemo, useRef, useState } from "react";
import { ChoiceRow, HouseCabinet, HouseHistory, HousePage, RulesSheet, StakeChips, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useCasinoSession } from "./use-casino-session";
import type { WheelRecord, WheelRisk, WheelSpin, WheelState } from "../lib/api";
import { formatMoney } from "../lib/format";

const SPIN_MS = 3600;
/** A segment's colour by what it pays. */
function colourOf(multiplier: number): string {
  if (multiplier === 0) return "#2b2f3a";
  if (multiplier < 1.3) return "#1f8a70";
  if (multiplier < 1.6) return "#2fb36b";
  if (multiplier < 2.5) return "#2f7de1";
  if (multiplier < 4) return "#8b4fe0";
  if (multiplier < 10) return "#f08a24";
  return "#f2c230";
}
const label = (multiplier: number) => (multiplier === 0 ? "0" : `${multiplier}×`);

/** The wheel: 30 slices, drawn as SVG, turned so the segment it stops on sits under the pointer. */
function Wheel({ segments, rotation, spinning }: { segments: number[]; rotation: number; spinning: boolean }) {
  const slice = 360 / segments.length;
  const r = 100;
  const point = (deg: number, radius: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [110 + radius * Math.cos(rad), 110 + radius * Math.sin(rad)];
  };
  return (
    <div className="wheel-scene">
      <span className="wheel-pointer" aria-hidden="true" />
      <svg viewBox="0 0 220 220" className="wheel-svg" style={{ transform: `rotate(${rotation}deg)`, transitionDuration: spinning ? `${SPIN_MS}ms` : "0ms" }} aria-hidden="true">
        <circle cx="110" cy="110" r="108" fill="#11131a" stroke="#f2c230" strokeWidth="3" />
        {segments.map((multiplier, i) => {
          const [x1, y1] = point(i * slice, r);
          const [x2, y2] = point((i + 1) * slice, r);
          const [tx, ty] = point(i * slice + slice / 2, r - 16);
          return (
            <g key={i}>
              <path d={`M110 110 L${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2} Z`} fill={colourOf(multiplier)} stroke="#11131a" strokeWidth="1" />
              {multiplier > 0 ? (
                <text x={tx} y={ty} fill="#fff" fontSize="7.5" fontWeight="800" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${i * slice + slice / 2} ${tx} ${ty})`}>
                  {multiplier}
                </text>
              ) : null}
            </g>
          );
        })}
        <circle cx="110" cy="110" r="22" fill="#11131a" stroke="#f2c230" strokeWidth="3" />
      </svg>
    </div>
  );
}

/** Money Wheel for a Player: pick a risk, spin, win the segment's multiplier. */
export function WheelGame() {
  useCasinoSession("wheel", "Money Wheel");
  const { t, tn } = useI18n();
  const g = useHouseGame<WheelState>("/casino/wheel");
  const [risk, setRisk] = useState<WheelRisk>("MEDIUM");
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<WheelSpin | null>(null);
  const [rules, setRules] = useState(false);
  const rotationRef = useRef(0);

  const wheels = g.state?.game.wheels;
  const segments = useMemo(() => wheels?.[risk] ?? [], [wheels, risk]);
  const legend = useMemo(() => {
    const counts = new Map<number, number>();
    for (const value of segments) counts.set(value, (counts.get(value) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  }, [segments]);

  async function spin() {
    if (!g.state || g.busy || g.stakeProblem) return;
    g.setBusy(true);
    slotSound.unlock();
    slotSound.spinStart();
    setResult(null);
    const response = await g.send<WheelSpin>("spin", { bet: g.stake, risk });
    if (!response) {
      g.setBusy(false);
      return;
    }
    g.setBalance(Math.round((g.balance - response.bet) * 100) / 100);
    const slice = 360 / segments.length;
    // Forward five turns, then to the segment's middle under the pointer at the top.
    const target = 360 - (response.segment * slice + slice / 2);
    const base = Math.ceil(rotationRef.current / 360) * 360 + 5 * 360;
    const next = base + target;
    rotationRef.current = next;
    setSpinning(true);
    setRotation(next);
    window.setTimeout(() => {
      setSpinning(false);
      setResult(response);
      g.setBalance(response.balance);
      g.tally(response.bet, response.win);
      if (response.win > 0) slotSound.win(response.multiplier >= 5);
      g.setState((current) => (current ? { ...current, recent: [{ id: response.id, bet: response.bet, win: response.win, round: { game: "wheel" as const, risk: response.risk, segment: response.segment, multiplier: response.multiplier }, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 20) } : current));
      g.setBusy(false);
    }, document.hidden ? 0 : SPIN_MS);
  }

  if (!g.state) return <PageLoading label="Loading the Casino" />;
  const state = g.state;
  const riskName = (value: WheelRisk) => (value === "LOW" ? t("Low risk") : value === "MEDIUM" ? t("Medium risk") : t("High risk"));

  return (
    <HousePage
      title={t("Money Wheel")}
      intro={t("Pick a risk and spin. The wheel pays the multiplier it stops on.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <HouseCabinet
          game="wheel"
          title={t("Money Wheel")}
          balance={g.balance}
          visit={g.visit}
          onRules={() => setRules(true)}
          stage={
            <div className="wheel-stage" aria-live="polite">
              <Wheel segments={segments} rotation={rotation} spinning={spinning} />
              <p className={`house-result${result ? (result.win > 0 ? " is-win" : " is-loss") : ""}`}>
                {spinning ? t("Spinning…") : result ? (result.win > 0 ? t("{multiplier}× · You won {amount}", { multiplier: result.multiplier, amount: formatMoney(result.win) }) : t("No win this time")) : t("Pick a risk, then spin.")}
              </p>
              <div className="wheel-legend">
                {legend.map(([value, count]) => (
                  <span key={value} style={{ borderColor: colourOf(value) }}>
                    <i style={{ background: colourOf(value) }} />
                    {label(value)} <small>×{count}</small>
                  </span>
                ))}
              </div>
            </div>
          }
          controls={
            <>
              <ChoiceRow label={t("Risk")} options={state.game.risks.map((value) => [value, riskName(value)] as [WheelRisk, string])} value={risk} onChange={setRisk} disabled={g.busy} />
              <StakeChips bets={state.game.bets} tableMax={state.tableMax} stake={g.stake} onStake={g.setStake} disabled={g.busy} />
              <button type="button" className="dice-go" disabled={g.busy || !!g.stakeProblem} onClick={() => void spin()}>
                {g.busy ? t("Spinning…") : t("Spin")}
              </button>
              {g.stakeProblem ? <p className="dice-problem">{g.stakeProblem}</p> : null}
            </>
          }
        />
      }
      history={
        <HouseHistory<WheelRecord>
          title="Your last spins"
          help="Your newest Money Wheel spins. They're also in My money, as one Money Wheel line for each day."
          empty="No spins yet."
          rows={state.recent}
          describe={(round) => ({ head: round ? label(round.multiplier) : "—", detail: round ? riskName(round.risk) : "" })}
        />
      }
      rules={
        rules ? (
          <RulesSheet onClose={() => setRules(false)}>
            <p>{t("Pick a risk and a stake, then spin. The wheel has 30 segments, each as likely; you're paid your stake times the multiplier the pointer stops on. 0 loses the stake.")}</p>
            <p>{t("Low risk wins small and often, high risk rarely and big.")}</p>
            {state.game.risks.map((value) => (
              <p key={value}>
                <strong>{riskName(value)}:</strong>{" "}
                {Array.from(new Set(state.game.wheels[value]))
                  .sort((a, b) => a - b)
                  .map((m) => `${label(m)} (${tn(state.game.wheels[value].filter((x) => x === m).length, "{count} segment", "{count} segments")})`)
                  .join(" · ")}
              </p>
            ))}
          </RulesSheet>
        ) : null
      }
    />
  );
}
