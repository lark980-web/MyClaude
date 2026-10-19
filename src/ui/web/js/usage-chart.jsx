import React from "react";
import { createRoot } from "react-dom/client";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip
} from "recharts";

const rootsMap = new WeakMap();

function formatCompact(n) {
  const num = Number(n || 0);
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return String(num);
}

function CustomTooltip({ active, payload, label, metric }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload || {};
  return (
    <div className="rc-usage-tooltip">
      <div className="rc-tip-date">{row.fullDate || label} · {row.weekday || ""}</div>
      <div className="rc-tip-row">
        <span className="rc-tip-dot tok" />
        <span>Token 消耗：</span>
        <b>{ Number(row.tokens || 0).toLocaleString() } tok</b>
      </div>
      <div className="rc-tip-row">
        <span className="rc-tip-dot req" />
        <span>请求频次：</span>
        <b>{ Number(row.requests || 0) } 次</b>
      </div>
      {typeof row.sessions === "number" && (
        <div className="rc-tip-sub">涉及活跃对话：{row.sessions} 个</div>
      )}
    </div>
  );
}

function UsageChartWidget({ data = [], metric = "tokens", chartType = "area", height = 148 }) {
  const isTokens = metric !== "requests";
  const dataKey = isTokens ? "tokens" : "requests";
  const strokeColor = isTokens ? "var(--accent, #c96442)" : "var(--info, #3b6fb0)";
  const gradId = `rcGrad-${metric}-${height}`;

  return (
    <div
      className="rc-chart-box"
      style={{ width: "100%", height: `${height}px`, minWidth: 0, overflow: "hidden" }}
    >
      <ResponsiveContainer width="100%" height={height} minWidth={0}>
        {chartType === "bar" ? (
          <BarChart data={data} margin={{ top: 6, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line, rgba(128,128,128,0.15))" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 9.5, fill: "var(--fg-4, #9d9a91)" }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tickFormatter={formatCompact}
              tick={{ fontSize: 9.5, fill: "var(--fg-4, #9d9a91)" }}
              axisLine={false}
              tickLine={false}
              width={42}
            />
            <Tooltip content={<CustomTooltip metric={metric} />} cursor={{ fill: "var(--hover, rgba(0,0,0,0.04))" }} />
            <Bar
              dataKey={dataKey}
              fill={strokeColor}
              radius={[4, 4, 0, 0]}
              maxBarSize={18}
              isAnimationActive={true}
              animationDuration={360}
            />
          </BarChart>
        ) : (
          <AreaChart data={data} margin={{ top: 6, right: 4, left: -24, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={strokeColor} stopOpacity={0.34} />
                <stop offset="95%" stopColor={strokeColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line, rgba(128,128,128,0.15))" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 9.5, fill: "var(--fg-4, #9d9a91)" }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tickFormatter={formatCompact}
              tick={{ fontSize: 9.5, fill: "var(--fg-4, #9d9a91)" }}
              axisLine={false}
              tickLine={false}
              width={42}
            />
            <Tooltip content={<CustomTooltip metric={metric} />} />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={strokeColor}
              strokeWidth={2}
              fillOpacity={1}
              fill={`url(#${gradId})`}
              activeDot={{ r: 3.5, strokeWidth: 0, fill: strokeColor }}
              isAnimationActive={true}
              animationDuration={360}
            />
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Mount or update a Recharts 7-day usage visualization inside any DOM container.
 */
window.renderUsageStatisticsChart = function renderUsageStatisticsChart(container, options = {}) {
  if (!container) return;
  let root = rootsMap.get(container);
  if (!root) {
    root = createRoot(container);
    rootsMap.set(container, root);
  }
  root.render(
    <UsageChartWidget
      data={options.data || []}
      metric={options.metric || "tokens"}
      chartType={options.chartType || "area"}
      height={options.height || 148}
    />
  );
};
