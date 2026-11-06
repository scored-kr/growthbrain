const emailValid = (value) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passwordValid = (value) => value.length >= 12 && value.length <= 1024;
const codeValid = (value) => value.length >= 6 && value.length <= 2048 && !/\s/.test(value);
export class AccountAuth {
    provider;
    now;
    state;
    queue = Promise.resolve();
    revision = 0;
    listeners = new Set();
    constructor(provider, now = () => Date.now()) {
        this.provider = provider;
        this.now = now;
        this.state = { status: provider ? 'signed_out' : 'unconfigured', busy: false, identity: null, error: null };
    }
    snapshot() { if (this.state.identity && this.state.identity.expiresAt <= this.now())
        this.state = { status: 'signed_out', identity: null, busy: this.state.busy, error: 'expired' }; return structuredClone(this.state); }
    subscribe(listener) { this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener); }; }
    publish(next) { this.state = next; for (const listener of this.listeners)
        listener(this.snapshot()); }
    identity(value) {
        if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.userId) || !emailValid(value.email) || value.emailVerified !== true || !Number.isFinite(value.expiresAt) || value.expiresAt <= this.now())
            throw Error('INVALID_IDENTITY');
        return { userId: value.userId, email: value.email, emailVerified: true, expiresAt: value.expiresAt };
    }
    run(valid, action, clear = false) {
        if (!this.provider)
            return Promise.resolve();
        if (!valid) {
            this.publish({ ...this.snapshot(), error: 'invalid_input' });
            return Promise.resolve();
        }
        const provider = this.provider, revision = ++this.revision;
        this.publish({ status: clear ? 'signed_out' : this.snapshot().status, busy: true, identity: clear ? null : this.snapshot().identity, error: null });
        const run = this.queue.then(async () => {
            try {
                const result = await action(provider);
                if (revision === this.revision)
                    this.publish({ status: result.status, busy: false, identity: result.identity ?? null, error: null });
            }
            catch (error) {
                if (revision === this.revision) {
                    const unverified = typeof error === 'object' && error !== null && 'code' in error && error.code === 'EMAIL_NOT_VERIFIED';
                    this.publish({ status: unverified ? 'verification_pending' : 'signed_out', busy: false, identity: null, error: unverified ? 'verification_required' : 'request_failed' });
                }
            }
        });
        this.queue = run;
        return run;
    }
    signUp(email, password) { return this.run(emailValid(email) && passwordValid(password), async (p) => { await p.signUp(email.trim(), password); return { status: 'verification_pending' }; }, true); }
    verifyEmail(code) { return this.run(codeValid(code), async (p) => { await p.verifyEmail(code); return { status: 'signed_out' }; }, true); }
    signIn(email, password) { return this.run(emailValid(email) && passwordValid(password), async (p) => ({ status: 'authenticated', identity: this.identity(await p.signIn(email.trim(), password)) }), true); }
    refresh() { return this.run(this.snapshot().status === 'authenticated', async (p) => ({ status: 'authenticated', identity: this.identity(await p.refresh()) })); }
    signOut() { return this.run(true, async (p) => { await p.signOut(); return { status: 'signed_out' }; }, true); }
    requestPasswordReset(email) { return this.run(emailValid(email), async (p) => { await p.requestPasswordReset(email.trim()); return { status: 'reset_requested' }; }, true); }
    confirmPasswordReset(code, password) { return this.run(codeValid(code) && passwordValid(password), async (p) => { await p.confirmPasswordReset(code, password); await p.signOut(); return { status: 'signed_out' }; }, true); }
}
