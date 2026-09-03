/* Autentificare cu nume de utilizator și parolă prin Supabase Auth. */
const Auth = (() => {
  const DOMAIN = '@talant.app';
  let clientInstance = null;
  let session = null;
  let onChange = null;

  function client() {
    if (!clientInstance && typeof supabase !== 'undefined') {
      clientInstance = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, storageKey: 'talant_auth' },
      });
    }
    return clientInstance;
  }

  function normalizeUsername(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  }

  // Partea locală a emailului sintetic. Înregistrarea și autentificarea trebuie
  // să o construiască identic, altfel un nume cu spațiu creează contul pe
  // „ana maria@…" dar îl caută la login pe „ana_maria@…".
  function accountLocalPart(username) {
    return normalizeUsername(username).toLocaleLowerCase('ro-RO').replace(/\s/g, '_');
  }

  function loginEmails(username) {
    const value = accountLocalPart(username);
    // Formularul este bazat pe nume de utilizator, însă acceptăm și emailul
    // intern complet pentru conturile create manual din Supabase Dashboard.
    if (!value.includes('@')) return [value + DOMAIN, value + '@test.com'];
    // Emailul complet poate fi tastat cu domeniul greșit față de cel cu care
    // a fost creat contul (ex. cont creat pe @test.com, dar userul scrie
    // @talant.app) — încercăm și varianta cu domeniul opus înainte să cedăm.
    const [local, domain] = value.split('@');
    const sibling = domain === 'test.com' ? DOMAIN.slice(1) : domain === DOMAIN.slice(1) ? 'test.com' : null;
    return sibling ? [value, `${local}@${sibling}`] : [value];
  }

  function displayName(user) {
    // Numele afișat nu trebuie să conțină niciodată un email întreg — pentru
    // conturile mai vechi la care username-ul salvat era încă un email complet,
    // sau la fallback pe email, păstrăm doar partea dinaintea lui @.
    const raw = user?.user_metadata?.username || (user?.email || '').replace(DOMAIN, '');
    const name = normalizeUsername(raw.includes('@') ? raw.split('@')[0] : raw);
    // Afișăm consecvent numele cu inițială mare, indiferent cum a fost creat
    // contul în formular sau direct în Supabase.
    return name ? name.slice(0, 1).toLocaleUpperCase('ro-RO') + name.slice(1) : null;
  }

  function userFriendlyError(message) {
    if (message?.includes('Invalid login') || message?.includes('invalid_credentials')) return 'Nume sau parolă incorectă.';
    if (message?.includes('already registered') || message?.includes('already been registered') || message?.includes('duplicate key') || message?.includes('users_email_partial_key')) return 'Acest nume de utilizator este deja folosit. Încearcă să intri în cont sau alege alt nume.';
    if (message?.includes('email not confirmed') || message?.includes('Email not confirmed')) return 'Acest cont nu este confirmat în Supabase. Verifică să folosești exact același nume sau email cu care a fost creat contul.';
    if (message?.includes('Password should')) return 'Parola trebuie să aibă cel puțin 6 caractere.';
    if (message?.includes('rate limit')) return 'Prea multe încercări. Încearcă mai târziu.';
    return message || 'Eroare necunoscută.';
  }

  async function init(callback) {
    onChange = callback;
    const c = client();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    session = data.session;
    c.auth.onAuthStateChange((_, nextSession) => {
      session = nextSession;
      onChange?.(currentUser());
    });
    return currentUser();
  }

  async function signIn(username, password) {
    const c = client();
    if (!c) throw new Error('Serviciul de autentificare nu este disponibil.');
    let lastError = null;
    for (const email of loginEmails(username)) {
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (!error) {
        session = data.session;
        return currentUser();
      }
      lastError = error;
    }
    throw new Error(userFriendlyError(lastError?.message));
  }

  async function signUp(username, password) {
    const name = normalizeUsername(username);
    if (name.length < 2) throw new Error('Numele trebuie să aibă cel puțin 2 caractere.');
    if (password.length < 6) throw new Error('Parola trebuie să aibă cel puțin 6 caractere.');
    // Înregistrarea acceptă doar nume de utilizator. Un email complet ar fi
    // devenit adresa contului, iar domeniul lui decidea cândva grupa din
    // clasament — deci oricine își putea alege grupa scriind aici un email de
    // biserică. Conturile pe domenii de grupă se creează din Supabase Dashboard,
    // iar grupa se atribuie în talant_group_members.
    if (name.includes('@')) {
      throw new Error('Scrie doar numele de utilizator, fără email. Conturile de grupă sunt create de administrator.');
    }
    const c = client();
    if (!c) throw new Error('Serviciul de autentificare nu este disponibil.');
    const { data, error } = await c.auth.signUp({
      email: accountLocalPart(name) + DOMAIN,
      password, options: { data: { username: name } },
    });
    if (error) throw new Error(userFriendlyError(error.message));
    if (data.user && !data.session) throw new Error('Confirmarea prin email este activă în configurația Supabase.');
    session = data.session;
    return currentUser();
  }

  async function signOut() {
    await client()?.auth.signOut();
    session = null;
  }

  async function accessToken() {
    const { data } = await client()?.auth.getSession() || {};
    return data?.session?.access_token || null;
  }

  function currentUser() { return displayName(session?.user); }
  function userId() { return session?.user?.id || null; }
  return { init, signIn, signUp, signOut, accessToken, currentUser, userId };
})();
