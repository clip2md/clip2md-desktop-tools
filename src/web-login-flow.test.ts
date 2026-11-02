import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const ui = vi.hoisted(() => ({ modals: [] as Array<{ contentEl: HTMLElement; close(): void }>, profile: vi.fn() }));
vi.mock('./account-profile', async original => ({ ...await original<typeof import('./account-profile')>(), readAccountProfile: ui.profile }));
vi.mock('obsidian', async original => ({
    ...await original<typeof import('obsidian')>(),
    Modal: class {
        titleEl = Object.assign(document.createElement('h1'), { setText(text: string) { this.textContent = text; } });
        contentEl = Object.assign(document.createElement('div'), { createEl(tag: string, options: {text: string}) { const el = document.createElement(tag); el.textContent = options.text; this.append(el); return el; } });
        onClose = () => {};
        constructor() { ui.modals.push(this); }
        open() {}
        close() { this.onClose(); }
    },
    Setting: class {
        constructor(private root: HTMLElement) {}
        addButton(fn: (button: unknown) => void) {
            const element = document.createElement('button'); this.root.append(element);
            const button = { setButtonText(text: string) { element.textContent = text; return button; }, onClick(fn: () => void) { element.onclick = fn; return button; } };
            fn(button); return this;
        }
    },
}));
import DesktopTools from './main';
import { normalizeSettings } from './config';
import { enqueue, readQueueState, jobKey } from './queue';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const scope = 'a'.repeat(64);
const context = (taskId=1, sourceUrl='https://example.com/private') => ({taskId,sourceUrl,bindingScope:scope,contentVersion:'1',notePath:`Notes/${taskId}.md`,daily:false});
function fixture() {
    const instance = new DesktopTools();
    const state = readQueueState(null);
    enqueue(state,context(),'article');state.jobs[0].status='waiting-auth';
    enqueue(state,context(2,'https://other.example/private'),'article');state.jobs[1].status='waiting-auth';
    let secret = '';
    const win = Object.assign(new EventEmitter(), {webContents:{},show:vi.fn(),focus:vi.fn()});
    const sessions = {
        login:vi.fn(async()=>win),hasStoredAuthorization:vi.fn(()=>!!secret),cookieAuthFingerprint:vi.fn(async()=>''),
        authorizationCheckpoint:vi.fn(()=>{const before=secret;return ()=>{secret=before;};}),
        save:vi.fn(async()=>{secret='saved-cookie-or-storage';}),setWebDomains:vi.fn(),release:vi.fn(),
    };
    const savePreferences=vi.fn(async()=>{}),persist=vi.fn(),drain=vi.fn();
    Object.assign(instance,{alive:true,manuallyEnabled:true,scope,bridge:{},settings:normalizeSettings({platformEnabled:{web:true}}),sessions,state,savePreferences,persist,drain});
    ui.profile.mockImplementation(async()=>secret?{state:'authenticated',nickname:'example.com',sessionOnly:true}:{state:'missing'});
    return {instance,state,sessions,savePreferences,persist,drain,secret:()=>secret};
}
beforeEach(()=>{ui.modals=[];ui.profile.mockReset();});

describe('generic login save and queue lifecycle',()=>{
    it('shares one login window and commits credentials/domain before resuming only that domain',async()=>{
        const f=fixture();
        const pending=f.instance['login']('web:example.com','https://example.com/private');
        expect(f.instance['login']('web:example.com')).toBe(pending);
        await flush();
        expect(f.sessions.login).toHaveBeenCalledOnce();expect(f.instance['settings'].webDomains).toEqual([]);
        ui.modals[0].contentEl.querySelector('button')!.click();await flush();
        await expect(pending).resolves.toMatchObject({state:'authenticated'});
        expect(f.instance['settings'].webDomains).toEqual(['example.com']);expect(f.secret()).toBeTruthy();
        expect(f.savePreferences).toHaveBeenCalledOnce();expect(f.state.jobs.map(job=>job.status)).toEqual(['queued','waiting-auth']);
        expect(f.drain).toHaveBeenCalled();
    });
    it.each(['credentials','preferences'])('keeps jobs paused and rolls back when saving %s fails',async failure=>{
        const f=fixture();
        if(failure==='credentials')f.sessions.save.mockRejectedValue(new Error('SecretStorage unavailable'));
        else f.savePreferences.mockRejectedValueOnce(new Error('settings unavailable'));
        const pending=f.instance['login']('web:example.com');await flush();
        ui.modals[0].contentEl.querySelector('button')!.click();await flush();
        expect(f.instance['settings'].webDomains).toEqual([]);expect(f.secret()).toBe('');
        expect(f.state.jobs.every(job=>job.status==='waiting-auth')).toBe(true);expect(f.drain).not.toHaveBeenCalled();
        ui.modals[0].close();await expect(pending).resolves.toBe(false);
    });
    it('keeps a concurrently saved domain when this domain registration fails',async()=>{
        const f=fixture();
        f.savePreferences.mockImplementationOnce(async()=>{
            f.instance['settings'].webDomains.push('other.example');
            throw new Error('settings unavailable');
        });
        const pending=f.instance['login']('web:example.com');await flush();
        ui.modals[0].contentEl.querySelector('button')!.click();await flush();
        expect(f.instance['settings'].webDomains).toEqual(['other.example']);
        expect(f.state.jobs.every(job=>job.status==='waiting-auth')).toBe(true);
        ui.modals[0].close();await pending;
    });
    it('cancels just the login attempt, persists suppression, and does not reopen it after reconnecting',async()=>{
        const f=fixture();
        const pending=f.instance['promptLogin']('web:example.com');await flush();
        expect(f.sessions.login).toHaveBeenCalledWith('web:example.com',expect.any(Function),'https://example.com/private');
        ui.modals[0].close();await pending;
        expect(f.state.jobs[0]).toMatchObject({status:'waiting-auth',authPrompted:true});expect(f.instance['settings'].platformEnabled.web).toBe(true);
        // Rehydrate the real queue format, then reconnect. Saved credentials
        // are not by themselves evidence that the target page is readable.
        f.instance['state']=readQueueState(JSON.parse(JSON.stringify(f.state)));
        await f.instance['promptWaitingAuthJobs']();
        expect(f.sessions.login).toHaveBeenCalledOnce();expect(f.instance['state'].jobs[0].status).toBe('waiting-auth');
        expect(f.instance['state'].jobs[1].status).toBe('queued');
        enqueue(f.instance['state'],context(),'article',true);
        expect(f.instance['state'].jobs[0].authPrompted).toBeUndefined();
    });
    it('retains suppression after saving a login so another blocked page cannot start a loop',async()=>{
        const f=fixture();const pending=f.instance['promptLogin']('web:example.com');await flush();
        ui.modals[0].contentEl.querySelector('button')!.click();await pending;
        expect(f.state.jobs[0].authPrompted).toBe(true);
        f.state.jobs[0].status='waiting-auth';
        await f.instance['promptWaitingAuthJobs']();
        expect(f.sessions.login).toHaveBeenCalledOnce();expect(f.state.jobs[0].status).toBe('waiting-auth');
    });
    it('cancels legacy generic extra jobs while retaining their saved material and completed jobs',()=>{
        const state=readQueueState(null);
        for(const feature of ['video','subtitles','comments'] as const)enqueue(state,context(),feature);
        state.jobs[1].status='complete';
        state.jobs[0].saved={properties:{},assets:[],files:[]};
        const restored=readQueueState(JSON.parse(JSON.stringify(state)));
        expect(restored.jobs.map(job=>job.status)).toEqual(['cancelled','complete','cancelled']);
        expect(restored.jobs[0].saved).toEqual(state.jobs[0].saved);
    });
});

it('requires manual Taobao confirmation and only resumes jobs in the shared buyer session',async()=>{
  const f=fixture();f.instance['settings'].platformEnabled.taobao=true;
  f.state.jobs[0].context.sourceUrl='https://item.taobao.com/item.htm?id=123';
  f.state.jobs[0].key=jobKey(f.state.jobs[0].context,'article');
  const pending=f.instance['promptLogin']('taobao');await flush();
  expect(f.sessions.login).toHaveBeenCalledWith('taobao',expect.any(Function),'https://item.taobao.com/item.htm?id=123');
  expect(f.sessions.save).not.toHaveBeenCalled();
  ui.modals[0].contentEl.querySelector('button')!.click();await pending;
  expect(f.sessions.save).toHaveBeenCalledWith('taobao',expect.anything(),expect.anything(),true);
  expect(f.state.jobs[0]).toMatchObject({status:'queued',authPrompted:true});
  expect(f.state.jobs[1].status).toBe('waiting-auth');
  expect(f.instance['settings'].webDomains).toEqual([]);
});

it('keeps a cancelled or ineffective Taobao challenge paused across reloads',async()=>{
  const f=fixture();f.instance['settings'].platformEnabled.taobao=true;
  f.state.jobs[0].context.sourceUrl='https://detail.tmall.com/item.htm?id=123';
  f.state.jobs[0].key=jobKey(f.state.jobs[0].context,'article');
  const pending=f.instance['promptLogin']('taobao');await flush();
  ui.modals[0].close();await pending;
  expect(f.state.jobs[0]).toMatchObject({status:'waiting-auth',authPrompted:true});
  f.instance['state']=readQueueState(JSON.parse(JSON.stringify(f.state)));
  await f.instance['promptWaitingAuthJobs']();
  expect(f.sessions.login).toHaveBeenCalledOnce();
  expect(f.instance['state'].jobs[0].status).toBe('waiting-auth');
});

it('automatically saves and closes a fresh Taobao login once buyer cookies are detected',async()=>{
  const f=fixture();
  const cookieLoginProfile=vi.fn(async()=>({state:'authenticated' as const,nickname:'淘宝/天猫',sessionOnly:true}));
  Object.assign(f.sessions,{cookieLoginProfile});
  const pending=f.instance['login']('taobao');await flush();
  await expect(pending).resolves.toMatchObject({state:'authenticated'});
  expect(cookieLoginProfile).toHaveBeenCalledOnce();expect(f.sessions.save).toHaveBeenCalledOnce();
  expect(f.sessions.release).toHaveBeenCalledOnce();
});

it('does not close an existing Taobao challenge when only its old buyer cookies remain',async()=>{
  vi.useFakeTimers();
  const f=fixture();
  f.sessions.hasStoredAuthorization.mockReturnValue(true);
  f.sessions.cookieAuthFingerprint.mockResolvedValue('stable-old-buyer-session');
  Object.assign(f.sessions,{cookieLoginProfile:vi.fn(async()=>({state:'authenticated' as const,nickname:'淘宝/天猫',sessionOnly:true}))});
  try{
    const pending=f.instance['login']('taobao');await flush();
    await vi.advanceTimersByTimeAsync(2400);
    expect(f.sessions.save).not.toHaveBeenCalled();expect(f.sessions.release).not.toHaveBeenCalled();
    ui.modals[0].contentEl.querySelector('button')!.click();await flush();
    await expect(pending).resolves.toMatchObject({state:'authenticated'});
  }finally{vi.clearAllTimers();vi.useRealTimers();}
});
