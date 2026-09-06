import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CheckCircle2, Clock3, FileText, LogOut, Mail, Plus, Search, Send, Settings, Upload, X } from 'lucide-react';
import './styles.css';
import { api, authUrl, slackConnectUrl } from './lib/api';
import type { EmailRecord, Sender, SlackStatus, User } from './types/email';

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status status-${status.toLowerCase()}`}>{status}</span>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [scheduled, setScheduled] = useState<EmailRecord[]>([]);
  const [sent, setSent] = useState<EmailRecord[]>([]);
  const [slack, setSlack] = useState<SlackStatus>({ connected: false, teamName: null });
  const [tab, setTab] = useState<'scheduled' | 'sent'>('scheduled');
  const [composeOpen, setComposeOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<EmailRecord[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function loadDashboard() {
    try {
      setLoading(true);
      setError('');
      const [me, senderList, scheduledList, sentList, slackStatus] = await Promise.all([
        api<User>('/auth/me'), api<Sender[]>('/senders'), api<EmailRecord[]>('/emails/scheduled'),
        api<EmailRecord[]>('/emails/sent'), api<SlackStatus>('/slack/status'),
      ]);
      setUser(me); setSenders(senderList); setScheduled(scheduledList); setSent(sentList); setSlack(slackStatus);
    } catch (err) {
      if (err instanceof Error && err.message === 'Not authenticated') setUser(null);
      else setError(err instanceof Error ? err.message : 'Unable to load dashboard');
    } finally { setLoading(false); }
  }

  useEffect(() => { void loadDashboard(); }, []);

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const query = search.trim();
    if (!query) { setSearchResults(null); return; }
    try { setSearching(true); setError(''); setSearchResults(await api<EmailRecord[]>(`/emails/search?q=${encodeURIComponent(query)}`)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Search failed'); }
    finally { setSearching(false); }
  }

  async function disconnectSlack() {
    try { await api('/slack/disconnect', { method: 'POST' }); setSlack({ connected: false, teamName: null }); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to disconnect Slack'); }
  }

  if (loading) return <div className="screen-center"><div className="spinner" /><span>Loading ReachInbox...</span></div>;
  if (!user) return <div className="login-page"><div className="login-card"><div className="brand-mark">R</div><p className="eyebrow">ReachInbox</p><h1>Simple email scheduling.</h1><p className="muted">Schedule campaigns, track delivery, and keep your outreach moving without manual follow-ups.</p><a className="google-button" href={authUrl()}>Continue with Google</a>{error && <div className="alert error">{error}</div>}</div></div>;

  const activeEmails = searchResults ?? (tab === 'scheduled' ? scheduled : sent);

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark small">R</div><strong>ReachInbox</strong></div>
      <div className="header-actions">
        {slack.connected ? <button className="slack-pill" onClick={() => void disconnectSlack()} title="Disconnect Slack"><CheckCircle2 size={15} /> Slack connected</button> : <a className="icon-link" href={slackConnectUrl()} title="Connect Slack"><Settings size={18} /></a>}
        <div className="profile"><img src={user.avatarUrl ?? ''} alt="" /><div><strong>{user.name}</strong><span>{user.email}</span></div></div>
        <button className="icon-button" onClick={() => void api('/auth/logout', { method: 'POST' }).then(() => setUser(null))}><LogOut size={17} /></button>
      </div>
    </header>

    <main className="dashboard">
      <div className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Email campaigns</h1><p className="muted">Manage scheduled and completed outreach from one place.</p></div><button className="primary-button" onClick={() => setComposeOpen(true)}><Plus size={18} /> Compose New Email</button></div>
      {error && <div className="alert error">{error}</div>}
      {slack.connected && <div className="alert success"><CheckCircle2 size={16} /> Slack connected to {slack.teamName ?? 'your workspace'}.</div>}

      <div className="stats-row"><div className="stat-card"><div className="stat-icon"><Clock3 size={18} /></div><span>Scheduled</span><strong>{scheduled.length}</strong></div><div className="stat-card"><div className="stat-icon"><Send size={18} /></div><span>Sent</span><strong>{sent.length}</strong></div><div className="stat-card"><div className="stat-icon"><Mail size={18} /></div><span>Senders</span><strong>{senders.length}</strong></div></div>

      <section className="panel">
        <div className="panel-toolbar"><div className="tabs"><button className={tab === 'scheduled' && !searchResults ? 'active' : ''} onClick={() => { setTab('scheduled'); setSearchResults(null); }}>Scheduled Emails</button><button className={tab === 'sent' && !searchResults ? 'active' : ''} onClick={() => { setTab('sent'); setSearchResults(null); }}>Sent Emails</button></div><form className="search-box" onSubmit={runSearch}><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search emails..." /><button type="submit" disabled={searching}>{searching ? '...' : 'Search'}</button></form></div>
        {searchResults && <div className="search-note">Showing {searchResults.length} search result{searchResults.length === 1 ? '' : 's'} <button onClick={() => { setSearchResults(null); setSearch(''); }}>Clear</button></div>}
        <EmailTable emails={activeEmails} scheduled={!searchResults && tab === 'scheduled'} />
      </section>
    </main>

    {composeOpen && <ComposeModal senders={senders} onClose={() => setComposeOpen(false)} onCreated={() => { setComposeOpen(false); void loadDashboard(); }} />}
  </div>;
}

function EmailTable({ emails, scheduled }: { emails: EmailRecord[]; scheduled: boolean }) {
  if (!emails.length) return <div className="empty"><div className="empty-icon"><Mail size={22} /></div><h3>No {scheduled ? 'scheduled' : 'matching'} emails</h3><p>{scheduled ? 'Create a campaign to see your scheduled emails here.' : 'Completed or matching emails will appear here.'}</p></div>;
  return <div className="table-wrap"><table><thead><tr><th>Email</th><th>Subject</th><th>{scheduled ? 'Scheduled time' : 'Sent time'}</th><th>Status</th></tr></thead><tbody>{emails.map((email) => <tr key={email.id}><td><strong>{email.to}</strong></td><td>{email.subject}</td><td>{formatDate(scheduled ? email.scheduledAt : email.sentAt)}</td><td><StatusBadge status={email.status} /></td></tr>)}</tbody></table></div>;
}

function ComposeModal({ senders, onClose, onCreated }: { senders: Sender[]; onClose: () => void; onCreated: () => void }) {
  const [senderId, setSenderId] = useState(senders[0]?.id ?? '');
  const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [recipients, setRecipients] = useState<string[]>([]);
  const [startTime, setStartTime] = useState(''); const [delay, setDelay] = useState('2000'); const [hourlyLimit, setHourlyLimit] = useState('50');
  const [fileName, setFileName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const countLabel = useMemo(() => `${recipients.length} valid email${recipients.length === 1 ? '' : 's'} detected`, [recipients.length]);

  async function parseFile(file: File) {
    const text = await file.text();
    const emails = [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((value) => value.toLowerCase()))];
    setRecipients(emails); setFileName(file.name); setError(emails.length ? '' : 'No valid email addresses were found in this file.');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!senderId) return setError('Select a sender before scheduling.');
    if (!recipients.length) return setError('Upload a file containing at least one email address.');
    const start = new Date(startTime);
    if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) return setError('Choose a future start time.');
    try { setBusy(true); setError(''); await api('/campaigns', { method: 'POST', body: JSON.stringify({ senderId, subject, body, startTime: start.toISOString(), delayMs: Number(delay), hourlyLimit: Number(hourlyLimit), recipients }) }); onCreated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to schedule campaign'); } finally { setBusy(false); }
  }

  return <div className="modal-backdrop"><div className="modal"><div className="modal-header"><div><p className="eyebrow">New campaign</p><h2>Compose email</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={submit}>
      <label>Sender<select value={senderId} onChange={(e) => setSenderId(e.target.value)} required><option value="" disabled>Select a sender</option>{senders.map((sender) => <option key={sender.id} value={sender.id}>{sender.name} — {sender.email}</option>)}</select></label>
      <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your email subject" required /></label>
      <label>Body<textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message..." rows={6} required /></label>
      <label>Lead file<div className="file-picker"><Upload size={17} /><span>{fileName || 'Choose a CSV or text file'}</span><input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => { const file = e.target.files?.[0]; if (file) void parseFile(file); }} /></div></label>
      <div className="file-count"><FileText size={15} /> {countLabel}</div>
      <div className="form-grid"><label>Start time<input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} required /></label><label>Delay between emails (ms)<input type="number" min="100" value={delay} onChange={(e) => setDelay(e.target.value)} required /></label><label>Hourly limit<input type="number" min="1" value={hourlyLimit} onChange={(e) => setHourlyLimit(e.target.value)} required /></label></div>
      {error && <div className="alert error">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Scheduling...' : 'Schedule campaign'}</button></div>
    </form>
  </div></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
