'use client';

import { useEffect, useRef, useState } from 'react';
import type { LoopEventEnvelope } from '../lib/api';

export function LoopEvents({ loopId }: { loopId: string }) {
  const [events, setEvents] = useState<LoopEventEnvelope[]>([]);
  const seen = useRef(new Set<string>());
  const lastSeq = useRef(0);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const query = lastSeq.current > 0 ? `?lastEventId=${lastSeq.current}` : '';
      source = new EventSource(`/api/loops/${loopId}/events${query}`);
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as LoopEventEnvelope;
        if (seen.current.has(event.id)) return;
        seen.current.add(event.id);
        lastSeq.current = Math.max(lastSeq.current, Number(event.id));
        setEvents((current) => [...current, event]);
      };
      source.addEventListener('loop.queued', source.onmessage as EventListener);
      source.addEventListener('workspace.ready', source.onmessage as EventListener);
      source.addEventListener('gate.completed', source.onmessage as EventListener);
      source.addEventListener('loop.completed', source.onmessage as EventListener);
      source.addEventListener('approval.completed', source.onmessage as EventListener);
      source.onerror = () => {
        source?.close();
        if (!stopped) reconnectTimer = setTimeout(connect, 250);
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [loopId]);

  return (
    <div className="card stack" data-testid="event-log">
      <div className="row">
        <h2>Live event log</h2>
        <span className="badge">dedup by seq</span>
      </div>
      {events.length === 0 ? <div className="empty">수신된 이벤트가 없습니다.</div> : null}
      <div className="code log">
        {events.map((event) => (
          <div key={event.id} data-testid="event-line">
            #{event.id} {event.type} {JSON.stringify(event.payload)}
          </div>
        ))}
      </div>
    </div>
  );
}
