(function(){
  "use strict";

  /* ============================================================
     STATE
  ============================================================ */
  var state = {
    capReady: false,
    config: null,
    user: null,
    capabilities: null,
    authMode: "login",   // login | dev-login | signup | signup-pending | forgot
    authError: "",
    authBusy: false,
    signupRole: "postgraduate",
    signupPendingMessage: "",
    view: "dashboard",
    loading: false,
    mobileNavOpen: false,
    toast: "",
    // roster (read-only view + AI generation panel -- see api.py's v2
    // permission model docstring)
    rosterUnit: null,
    rosterMonth: null,
    rosterPeople: [],
    rosterEntries: [],
    scheduleStatus: "none",
    published: false,
    canManageSchedule: false,
    scheduleRun: null,
    generateBusy: false,
    approveBusy: false,
    // my preferences (leave requests + duty preferences -- everyone's only
    // input to the AI schedule now)
    prefMonth: null,
    myLeaveRequests: [],
    myLeaveRequestsLoaded: false,
    myDutyPref: null,
    myDutyPrefLoaded: false,
    // my unit (Head of Unit's scoped role/designation/on-call-rank edit)
    unitMembers: [],
    unitMembersLoaded: false,
    editingUnitMemberUsername: null,
    // manage users (developer)
    devUsers: [],
    devUsersLoaded: false,
    showCreateUserForm: false,
    newUserRole: "postgraduate",
    editingUsername: null,
    // signup approvals (developer)
    signupRequests: [],
    signupRequestsLoaded: false,
    // account / change password
    pwError: "",
    pwBusy: false
  };

  var ROLE_LABELS = { postgraduate: "Postgraduate", fellow: "Fellow", professor: "Professor", developer: "Developer" };
  function roleLabel(r){ return ROLE_LABELS[r] || r; }

  /* ============================================================
     DEFAULT CONFIG (offline fallback only -- the real list always
     comes from the server; this just keeps the UI usable the one
     time /api/config itself fails to answer)
  ============================================================ */
  function defaultConfig(){
    return {
      shiftLeaveTypes: [
        { key:"day_duty", label:"Day Duty", category:"shift", color:"teal" },
        { key:"night_duty", label:"Night Duty", category:"shift", color:"violet" },
        { key:"on_call", label:"On Call", category:"oncall", color:"amber" },
        { key:"post_call", label:"Post-Call", category:"off", color:"grey" },
        { key:"off_day", label:"Off Day", category:"off", color:"green" },
        { key:"casual_leave", label:"Casual Leave", category:"leave", color:"red" },
        { key:"sick_leave", label:"Sick Leave", category:"leave", color:"red" },
        { key:"academic_leave", label:"Academic Leave", category:"leave", color:"blue" }
      ],
      units: [
        { key:"ent1", shortForm:"ENT 1", fullName:"Oto-laryngology Unit 1" },
        { key:"ent2", shortForm:"ENT 2", fullName:"Oto-laryngology Unit 2" },
        { key:"ent3", shortForm:"ENT 3", fullName:"Oto-laryngology Unit 3" },
        { key:"ent4", shortForm:"ENT 4", fullName:"Oto-laryngology Unit 4" },
        { key:"ent5", shortForm:"ENT 5", fullName:"Oto-laryngology Unit 5" }
      ],
      designations: ["Assistant Professor", "Associate Professor", "Professor", "Senior Professor"],
      onCallRanks: ["1st on call", "2nd on call", "3rd on call", "4th on call", "5th on call", "Not on call rotation"],
      posts: ["Head of Unit", "Other"]
    };
  }

  /* ============================================================
     LOOKUP HELPERS
  ============================================================ */
  function unitInfo(key){
    if(!key) return null;
    var list = (state.config && state.config.units) || [];
    for(var i=0;i<list.length;i++){ if(list[i].key===key) return list[i]; }
    return { key:key, shortForm:key, fullName:key };
  }
  function unitShort(key){ var u=unitInfo(key); return u ? u.shortForm : "—"; }
  function unitFull(key){ var u=unitInfo(key); return u ? u.fullName : "—"; }
  function unitOptions(selectedKey){
    return (state.config.units||[]).map(function(u){
      return '<option value="'+esc(u.key)+'" '+(u.key===selectedKey?"selected":"")+'>'+esc(u.fullName)+' ('+esc(u.shortForm)+')</option>';
    }).join("");
  }

  function typeInfo(key){
    if(!key) return null;
    var list = (state.config && state.config.shiftLeaveTypes) || [];
    for(var i=0;i<list.length;i++){ if(list[i].key===key) return list[i]; }
    return { key:key, label:key, category:"", color:"grey" };
  }

  function slugify(name){
    var s = String(name||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
    return s || ("x_"+Date.now());
  }
  function uniqueSlug(base, existingKeys){
    var s = slugify(base), key = s, n = 2;
    while(existingKeys.indexOf(key) !== -1){ key = s+"_"+n; n++; }
    return key;
  }

  /* ============================================================
     DATE HELPERS
  ============================================================ */
  function pad(n){ return n<10 ? "0"+n : ""+n; }
  function currentMonthStr(){ var d=new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1); }
  function daysInMonth(monthStr){
    var p = monthStr.split("-").map(Number);
    return new Date(p[0], p[1], 0).getDate();
  }
  function monthLabel(monthStr){
    var p = monthStr.split("-").map(Number);
    var d = new Date(p[0], p[1]-1, 1);
    return d.toLocaleDateString(undefined, { month:"long", year:"numeric" });
  }
  function addMonths(monthStr, delta){
    var p = monthStr.split("-").map(Number);
    var d = new Date(p[0], p[1]-1+delta, 1);
    return d.getFullYear()+"-"+pad(d.getMonth()+1);
  }
  function weekdayAbbrev(monthStr, day){
    var p = monthStr.split("-").map(Number);
    var d = new Date(p[0], p[1]-1, day);
    return d.toLocaleDateString(undefined, { weekday:"short" });
  }

  /* ============================================================
     ICONS -- same hand-drawn hatch style as the ENT Surgical Logbook
     project (generic glyphs only; nothing ENT-specific needed here).
  ============================================================ */
  var ICONS = {
    menu: '<path d="M8 12h24M8 20h24M8 28h24"/>',
    close: '<path d="M11 11l18 18M29 11L11 29"/>',
    users: '<circle cx="15" cy="14" r="5"/><path d="M6 33c0-6 4-10 9-10s9 4 9 10"/><circle cx="28" cy="16" r="4"/><path d="M22 33c0-5 3-8 6-8s6 3 6 8" class="hatch"/>',
    approvals: '<path d="M9 20l7 7 15-15"/><circle cx="20" cy="20" r="15"/>',
    lists: '<path d="M11 9h18M11 9v22h18V9" /><path class="hatch" d="M15 15h10M15 20h10M15 25h6"/>',
    calendar: '<rect x="7" y="10" width="26" height="23" rx="2"/><path d="M7 17h26"/><path d="M13 6v8M27 6v8" class="hatch"/><path d="M13 23h4M20 23h4M27 23h2M13 28h4M20 28h4" class="hatch"/>'
  };
  function icon(key, extraClass){
    var body = ICONS[key];
    if(!body) return "";
    return '<svg class="icon icon-hatch'+(extraClass?" "+extraClass:"")+'" viewBox="0 0 40 40" aria-hidden="true">'+body+'</svg>';
  }

  /* ============================================================
     UTIL
  ============================================================ */
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }
  function el(id){ return document.getElementById(id); }
  function cleanUsername(u){ return String(u||"").trim().toLowerCase().replace(/[^a-z0-9._-]/g,""); }
  function opts_(list, selected){
    return (list||[]).map(function(o){ return '<option '+(o===selected?"selected":"")+'>'+esc(o)+'</option>'; }).join("");
  }
  function radioCard(name, value, checked, title, desc){
    return '<label class="radio-card"><input type="radio" name="'+name+'" value="'+value+'" '+(checked?"checked":"")+'><span><span class="t">'+esc(title)+'</span><br><span class="d">'+esc(desc)+'</span></span></label>';
  }
  function statTile(value, label){
    return '<div class="stat-tile"><div><div class="num" style="font-size:16px;">'+esc(value)+'</div><div class="lbl">'+esc(label)+'</div></div></div>';
  }
  function dashCard(navTo, title, desc, iconKey){
    return '<button class="dash-card" data-nav="'+navTo+'"><div class="icn">'+(iconKey?icon(iconKey):esc(title.slice(0,1)))+'</div><div class="t">'+esc(title)+'</div><div class="d">'+esc(desc)+'</div></button>';
  }
  function toast(msg){ state.toast = msg; render(); setTimeout(function(){ if(state.toast===msg){ state.toast=""; render(); } }, 3200); }

  /* ============================================================
     API LAYER -- every call goes to the real Flask/SQLite backend
     over fetch(). Session auth is an httpOnly cookie the browser
     sends automatically; nothing here ever touches a password hash.
  ============================================================ */
  async function api(method, path, body){
    var opts = { method: method, headers:{}, credentials:"same-origin" };
    if(body!==undefined){ opts.headers["Content-Type"]="application/json"; opts.body=JSON.stringify(body); }
    var res = await fetch("/api"+path, opts);
    var data = null;
    try{ data = await res.json(); }catch(e){ data = null; }
    if(!res.ok){ throw new Error((data && data.error) || ("Request failed ("+res.status+")")); }
    return data;
  }

  async function dGetConfig(){ return (await api("GET","/config")).config; }
  async function dUpdateConfig(patch){ return (await api("PATCH","/config", patch)).config; }
  async function dListUsers(){ return (await api("GET","/users")).users; }
  async function dCreateUser(body){ return (await api("POST","/users", body)).user; }
  async function dUpdateUser(username, patch){ return (await api("PATCH","/users/"+encodeURIComponent(username), patch)).user; }
  async function dDeleteUser(username){ await api("DELETE","/users/"+encodeURIComponent(username)); }
  async function dListSignupRequests(){ return (await api("GET","/signup-requests")).requests; }
  async function dApproveSignup(username){ await api("POST","/signup-requests/"+encodeURIComponent(username)+"/approve"); }
  async function dRejectSignup(username){ await api("POST","/signup-requests/"+encodeURIComponent(username)+"/reject"); }
  async function dGetRoster(unit, month){
    var qs = "?month="+encodeURIComponent(month)+(unit?("&unit="+encodeURIComponent(unit)):"");
    return await api("GET","/roster"+qs);
  }
  async function dPutRosterEntry(body){ return (await api("PUT","/roster/entry", body)).entry; }
  async function dListLeaveRequests(unit){
    var qs = unit ? ("?unit="+encodeURIComponent(unit)) : "";
    return (await api("GET","/preferences/leave"+qs)).requests;
  }
  async function dCreateLeaveRequest(body){ return (await api("POST","/preferences/leave", body)).request; }
  async function dDeleteLeaveRequest(id){ await api("DELETE","/preferences/leave/"+id); }
  async function dGetDutyPreference(month){ return (await api("GET","/preferences/duty?month="+encodeURIComponent(month))).preference; }
  async function dPutDutyPreference(body){ return (await api("PUT","/preferences/duty", body)).preference; }
  async function dGenerateSchedule(body){ return await api("POST","/schedule/generate", body); }
  async function dApproveSchedule(body){ return await api("POST","/schedule/approve", body); }

  /* ============================================================
     BOOT
  ============================================================ */
  async function boot(){
    render();
    try{ state.config = await dGetConfig(); }catch(e){ state.config = defaultConfig(); }
    state.capReady = true;

    try{
      var me = await api("GET","/auth/me");
      if(me.user){ state.user = me.user; state.capabilities = me.capabilities; state.view = "dashboard"; }
    }catch(e){}
    render();

    if(state.user){
      loadForView();
      if(state.user.role==="developer"){
        try{ state.signupRequests = await dListSignupRequests(); state.signupRequestsLoaded = true; render(); }catch(e){}
      }
    }
  }

  /* ============================================================
     AUTH ACTIONS
  ============================================================ */
  async function doLogin(username, password, requireRole){
    state.authError=""; state.authBusy=true; render();
    try{
      var res = await api("POST","/auth/login", { username: cleanUsername(username), password: password, requireRole: requireRole });
      state.user = res.user; state.capabilities = res.capabilities; state.view = "dashboard";
      state.authBusy=false; render();
      if(state.user.role==="developer"){
        try{ state.signupRequests = await dListSignupRequests(); state.signupRequestsLoaded = true; render(); }catch(e){}
      }
    }catch(err){
      state.authError = err.message || "Something went wrong signing in. Please try again.";
      state.authBusy=false; render();
    }
  }

  async function doSignup(fields){
    state.authError=""; state.authBusy=true; render();
    try{
      if((fields.username||"").length < 3){ state.authError="Username must be at least 3 characters (letters, numbers, . _ -)."; state.authBusy=false; render(); return; }
      if((fields.password||"").length < 8){ state.authError="Password must be at least 8 characters."; state.authBusy=false; render(); return; }
      if(fields.password !== fields.confirm){ state.authError="Passwords do not match."; state.authBusy=false; render(); return; }
      var res = await api("POST","/auth/signup", {
        username: cleanUsername(fields.username), password: fields.password, confirm: fields.confirm,
        displayName: fields.displayName, role: fields.role, unit: fields.unit,
        designation: fields.designation, onCallRank: fields.onCallRank, post: fields.post
      });
      if(res.pending){
        state.authBusy=false; state.authMode="signup-pending";
        state.signupPendingMessage = res.message || "Your account is awaiting approval.";
        render();
        return;
      }
      state.user = res.user; state.capabilities = res.capabilities; state.view = "dashboard";
      state.authBusy=false; render();
      if(res.firstUser) toast("You're the first account on this roster — you've been made Developer.");
    }catch(err){
      state.authError = err.message || "Something went wrong creating the account. Please try again.";
      state.authBusy=false; render();
    }
  }

  async function submitForgotPassword(username, note){
    state.authError=""; state.authBusy=true; render();
    try{
      if((username||"").trim().length < 3){ state.authError="Enter your username first."; state.authBusy=false; render(); return; }
      await api("POST","/auth/forgot-password", { username: cleanUsername(username), note: (note||"").trim() });
      state.authBusy=false; state.authMode="login"; state.authError=""; render();
      toast("Request sent — the developer will set a new password.");
    }catch(e){
      state.authError = e.message || "Could not submit the request. Please try again.";
      state.authBusy=false; render();
    }
  }

  function doLogout(){
    api("POST","/auth/logout").catch(function(){});
    state.user = null; state.capabilities = null; state.authMode = "login";
    state.rosterPeople = []; state.rosterEntries = [];
    state.scheduleStatus = "none"; state.published = false; state.canManageSchedule = false; state.scheduleRun = null;
    state.myLeaveRequests = []; state.myLeaveRequestsLoaded = false;
    state.myDutyPref = null; state.myDutyPrefLoaded = false;
    state.unitMembers = []; state.unitMembersLoaded = false; state.editingUnitMemberUsername = null;
    state.devUsers = []; state.devUsersLoaded = false;
    state.signupRequests = []; state.signupRequestsLoaded = false;
    state.showCreateUserForm = false; state.editingUsername = null;
    render();
  }

  async function doChangePassword(oldPw, newPw, confirmPw){
    state.pwError=""; state.pwBusy=true; render();
    try{
      if((newPw||"").length < 8){ state.pwError="New password must be at least 8 characters."; state.pwBusy=false; render(); return; }
      if(newPw !== confirmPw){ state.pwError="New passwords do not match."; state.pwBusy=false; render(); return; }
      await api("POST","/auth/change-password", { oldPassword: oldPw, newPassword: newPw, confirm: confirmPw });
      state.pwBusy=false; render();
      toast("Password changed.");
    }catch(e){
      state.pwError = e.message || "Could not change password.";
      state.pwBusy=false; render();
    }
  }

  /* ============================================================
     RENDER: AUTH SCREENS
  ============================================================ */
  function renderLogin(){
    return ''+
    '<div class="center-shell"><div class="auth-card">'+
      '<div class="auth-eyebrow">ENT Postgraduate &amp; Fellowship Programme</div>'+
      '<h1>ENT Duty Roster</h1>'+
      '<div class="auth-sub">Sign in to view and edit your unit\'s monthly duty roster.</div>'+
      (state.authError ? '<div class="error-banner">'+esc(state.authError)+'</div>' : '')+
      '<div class="field"><label for="login-username">Username</label><input id="login-username" type="text" autocomplete="username"></div>'+
      '<div class="field"><label for="login-password">Password</label><input id="login-password" type="password" autocomplete="current-password"></div>'+
      '<button class="btn btn-primary" style="width:100%" id="btn-login" '+(state.authBusy?"disabled":"")+'>'+(state.authBusy?"Signing in…":"Sign in")+'</button>'+
      '<div style="text-align:center; margin-top:16px; font-size:13px;" class="muted">No account yet? <button class="link-btn" id="go-signup">Create one</button></div>'+
      '<div style="text-align:center; margin-top:8px; font-size:12.5px;" class="muted">Forgot your password? <button class="link-btn" id="go-forgot">Request a reset</button></div>'+
      '<div style="text-align:center; margin-top:18px; padding-top:12px; border-top:1px solid var(--line); font-size:11px;" class="muted"><button class="link-btn" id="go-devlogin" style="font-size:11px; color:var(--ink-soft);">Developer sign-in</button></div>'+
    '</div></div>';
  }

  function renderForgot(){
    return ''+
    '<div class="center-shell"><div class="auth-card">'+
      '<div class="auth-eyebrow">Password reset</div>'+
      '<h1>Request a new password</h1>'+
      '<div class="auth-sub">The developer sets the new password by hand — this just puts your request in their queue.</div>'+
      (state.authError ? '<div class="error-banner">'+esc(state.authError)+'</div>' : '')+
      '<div class="field"><label for="forgot-username">Username</label><input id="forgot-username" type="text" autocomplete="username"></div>'+
      '<div class="field"><label for="forgot-note">Note for the developer (optional)</label><textarea id="forgot-note" placeholder="Anything that helps them confirm it\'s you"></textarea></div>'+
      '<button class="btn btn-primary" style="width:100%" id="btn-forgot" '+(state.authBusy?"disabled":"")+'>'+(state.authBusy?"Sending…":"Send request")+'</button>'+
      '<div style="text-align:center; margin-top:16px; font-size:13px;" class="muted">Remembered it? <button class="link-btn" id="go-login-from-forgot">Back to sign in</button></div>'+
    '</div></div>';
  }

  function renderDevLogin(){
    return ''+
    '<div class="center-shell"><div class="auth-card">'+
      '<div class="auth-eyebrow">Developer sign-in</div>'+
      '<h1>Master control</h1>'+
      '<div class="auth-sub">Separate from regular sign-in. Only accounts already granted the Developer role can enter here.</div>'+
      (state.authError ? '<div class="error-banner">'+esc(state.authError)+'</div>' : '')+
      '<div class="field"><label for="dev-username">Developer username</label><input id="dev-username" type="text" autocomplete="username"></div>'+
      '<div class="field"><label for="dev-password">Password</label><input id="dev-password" type="password" autocomplete="current-password"></div>'+
      '<button class="btn btn-primary" style="width:100%" id="btn-devlogin" '+(state.authBusy?"disabled":"")+'>'+(state.authBusy?"Signing in…":"Sign in as Developer")+'</button>'+
      '<div style="text-align:center; margin-top:16px; font-size:13px;" class="muted">Not a developer? <button class="link-btn" id="go-login-from-dev">Back to regular sign-in</button></div>'+
    '</div></div>';
  }

  function renderSignupRoleFields(role){
    var cfg = state.config;
    return ''+
    '<div class="field"><label for="su-unit">Unit</label><select id="su-unit">'+unitOptions(null)+'</select></div>'+
    (role==="professor" ? '<div class="field"><label for="su-designation">Designation</label><select id="su-designation">'+opts_(cfg.designations, cfg.designations[0])+'</select></div>' : '')+
    '<div class="row2">'+
      '<div class="field"><label for="su-oncall">On-call rank</label><select id="su-oncall">'+opts_(cfg.onCallRanks, cfg.onCallRanks[cfg.onCallRanks.length-1])+'</select></div>'+
      '<div class="field"><label for="su-post">Post</label><select id="su-post">'+opts_(cfg.posts, cfg.posts[cfg.posts.length-1])+'</select></div>'+
    '</div>';
  }

  function renderSignup(){
    var role = state.signupRole;
    return ''+
    '<div class="center-shell"><div class="auth-card" style="max-width:460px;">'+
      '<div class="auth-eyebrow">ENT Postgraduate &amp; Fellowship Programme</div>'+
      '<h1>Create your account</h1>'+
      '<div class="auth-sub">Your account needs approval from the developer before you can sign in.</div>'+
      (state.authError ? '<div class="error-banner">'+esc(state.authError)+'</div>' : '')+
      '<div class="field"><label>I am a</label><div class="radio-group">'+
        radioCard("signup-role","postgraduate",role==="postgraduate","Postgraduate","Resident in training within a unit.")+
        radioCard("signup-role","fellow",role==="fellow","Fellow","Fellowship candidate within a unit.")+
        radioCard("signup-role","professor",role==="professor","Professor","Faculty member (Assistant / Associate / Professor / Senior Professor).")+
      '</div></div>'+
      '<div class="field"><label for="su-username">Username</label><input id="su-username" type="text"></div>'+
      '<div class="row2">'+
        '<div class="field"><label for="su-password">Password</label><input id="su-password" type="password"></div>'+
        '<div class="field"><label for="su-confirm">Confirm password</label><input id="su-confirm" type="password"></div>'+
      '</div>'+
      '<div class="field"><label for="su-displayName">Display name</label><input id="su-displayName" type="text" placeholder="e.g. Dr. Rohan Sharma"></div>'+
      '<div id="signup-role-fields">'+renderSignupRoleFields(role)+'</div>'+
      '<p class="hint">Your account needs approval before you can sign in — the developer will review it.</p>'+
      '<button class="btn btn-primary" style="width:100%; margin-top:6px;" id="btn-signup" '+(state.authBusy?"disabled":"")+'>'+(state.authBusy?"Creating account…":"Create account")+'</button>'+
      '<div style="text-align:center; margin-top:16px; font-size:13px;" class="muted">Already have an account? <button class="link-btn" id="go-login">Sign in</button></div>'+
    '</div></div>';
  }

  function renderSignupPending(){
    return ''+
    '<div class="center-shell"><div class="auth-card" style="text-align:center;">'+
      '<div class="auth-eyebrow">Account created</div>'+
      '<h1>Awaiting approval</h1>'+
      '<div class="auth-sub">'+esc(state.signupPendingMessage)+'</div>'+
      '<button class="btn btn-primary" style="width:100%; margin-top:16px;" id="go-login-from-pending">Back to sign in</button>'+
    '</div></div>';
  }

  function wireAuthEvents(){
    var goSignup=el("go-signup"); if(goSignup) goSignup.onclick=function(){ state.authMode="signup"; state.authError=""; render(); };
    var goLogin=el("go-login"); if(goLogin) goLogin.onclick=function(){ state.authMode="login"; state.authError=""; render(); };
    var btnLogin=el("btn-login"); if(btnLogin) btnLogin.onclick=function(){ doLogin(el("login-username").value, el("login-password").value); };
    var pwField=el("login-password"); if(pwField) pwField.addEventListener("keydown", function(ev){ if(ev.key==="Enter") el("btn-login").click(); });

    var goDevLogin=el("go-devlogin"); if(goDevLogin) goDevLogin.onclick=function(){ state.authMode="dev-login"; state.authError=""; render(); };
    var goLoginFromDev=el("go-login-from-dev"); if(goLoginFromDev) goLoginFromDev.onclick=function(){ state.authMode="login"; state.authError=""; render(); };
    var btnDevLogin=el("btn-devlogin"); if(btnDevLogin) btnDevLogin.onclick=function(){ doLogin(el("dev-username").value, el("dev-password").value, "developer"); };
    var devPwField=el("dev-password"); if(devPwField) devPwField.addEventListener("keydown", function(ev){ if(ev.key==="Enter") el("btn-devlogin").click(); });

    var goForgot=el("go-forgot"); if(goForgot) goForgot.onclick=function(){ state.authMode="forgot"; state.authError=""; render(); };
    var goLoginFromForgot=el("go-login-from-forgot"); if(goLoginFromForgot) goLoginFromForgot.onclick=function(){ state.authMode="login"; state.authError=""; render(); };
    var btnForgot=el("btn-forgot"); if(btnForgot) btnForgot.onclick=function(){ submitForgotPassword(el("forgot-username").value, el("forgot-note").value); };

    document.querySelectorAll('input[name="signup-role"]').forEach(function(r){
      r.onchange=function(){ state.signupRole=r.value; var wrap=el("signup-role-fields"); if(wrap) wrap.innerHTML = renderSignupRoleFields(r.value); };
    });
    var btnSignup=el("btn-signup"); if(btnSignup) btnSignup.onclick=function(){
      doSignup({
        username: el("su-username").value, password: el("su-password").value, confirm: el("su-confirm").value,
        displayName: el("su-displayName").value, role: state.signupRole,
        unit: (el("su-unit")||{}).value, designation: (el("su-designation")||{}).value,
        onCallRank: (el("su-oncall")||{}).value, post: (el("su-post")||{}).value
      });
    };
    var goLoginFromPending=el("go-login-from-pending"); if(goLoginFromPending) goLoginFromPending.onclick=function(){ state.authMode="login"; state.authError=""; render(); };
  }

  /* ============================================================
     RENDER: SHELL
  ============================================================ */
  function navItems(){
    if(state.user.role==="developer"){
      return [["dashboard","Dashboard"],["roster","Roster"],["manage-users","Users"],["signup-approvals","Approvals"],["manage-lists","Manage Lists"],["account","My Account"]];
    }
    var items = [["dashboard","Dashboard"],["roster","Roster"],["preferences","My Preferences"]];
    if(state.capabilities && state.capabilities.isHeadOfUnit) items.push(["unit-members","My Unit"]);
    items.push(["account","My Account"]);
    return items;
  }

  function renderShell(inner){
    var pendingCount = state.user.role==="developer" ? state.signupRequests.length : 0;
    return ''+
    '<div class="topbar">'+
      '<div class="brand">'+
        '<button type="button" class="nav-toggle" id="btn-nav-toggle" aria-label="'+(state.mobileNavOpen?"Close menu":"Open menu")+'">'+icon(state.mobileNavOpen?"close":"menu")+'</button>'+
        '<div class="brand-mark">DR</div><div class="brand-text"><h1>ENT Duty Roster</h1><div class="sub">Units 1–5</div></div>'+
      '</div>'+
      '<div class="user-chip"><span class="role-badge">'+esc(roleLabel(state.user.role))+'</span><span>'+esc(state.user.displayName)+'</span><button class="btn btn-ghost btn-sm" id="btn-logout">Log out</button></div>'+
    '</div>'+
    '<div class="shell-body">'+
      '<nav class="sidenav'+(state.mobileNavOpen?" open":"")+'">'+navItems().map(function(item){
        var badge = (item[0]==="signup-approvals" && pendingCount>0) ? '<span class="alert-count">'+pendingCount+'</span>' : "";
        return '<button data-nav="'+item[0]+'" class="'+(state.view===item[0]?"active":"")+'">'+esc(item[1])+badge+'</button>';
      }).join("")+'</nav>'+
      '<main'+(state.view==="roster"?' class="wide"':'')+'>'+
        (state.toast ? '<div class="success-banner">'+esc(state.toast)+'</div>' : '')+
        inner+
      '</main>'+
    '</div>'+
    '<div class="footer-note">ENT Duty Roster — Units 1–5</div>';
  }

  /* ============================================================
     RENDER: DASHBOARD
  ============================================================ */
  function renderDashboardUnit(){
    var u = state.user;
    var caps = state.capabilities || {};
    return ''+
    '<div class="card"><span class="eyebrow">Your profile</span><h2>'+esc(u.displayName)+'</h2>'+
      '<div class="stat-grid">'+
        statTile(unitShort(u.unit), "Unit")+
        statTile(roleLabel(u.role), "Role")+
        (u.designation ? statTile(u.designation, "Designation") : "")+
        (u.onCallRank ? statTile(u.onCallRank, "On-call rank") : "")+
        (u.post ? statTile(u.post, "Post") : "")+
        (u.isCoordinator ? statTile("Yes", "Schedule coordinator") : "")+
      '</div>'+
    '</div>'+
    '<div class="card"><h2>Duty roster</h2><p class="muted">Your unit\'s monthly schedule is generated by an AI module from everyone\'s submitted preferences, then approved by your coordinator. View it once it\'s published.</p>'+
      '<button class="btn btn-primary" data-nav="roster">Open roster</button>'+
    '</div>'+
    '<div class="card"><h2>Your preferences</h2><p class="muted">Submit leave requests and duty preferences here — this is your only input into the schedule; there is no direct grid editing.</p>'+
      '<button class="btn btn-primary" data-nav="preferences">Open preferences</button>'+
    '</div>'+
    (caps.isCoordinator ? '<div class="card"><h2>You\'re this unit\'s schedule coordinator</h2><p class="muted">Generate, redo and approve the AI-generated schedule from the Roster screen.</p></div>' : '')+
    (caps.isHeadOfUnit ? '<div class="card"><h2>Head of Unit</h2><p class="muted">You can edit role, designation and on-call rank for other members of your unit.</p><button class="btn btn-sm" data-nav="unit-members">Open My Unit</button></div>' : '');
  }

  function renderDashboardDeveloper(){
    return ''+
    '<div class="card"><h2>Developer control panel</h2><p class="muted">Master control for the ENT Duty Roster — manage accounts, approvals, and the master lists shared across every unit.</p>'+
      '<div class="dash-grid">'+
        dashCard("roster","Roster","View or edit any unit's duty roster.","calendar")+
        dashCard("manage-users","Users","Create, edit, deactivate or delete accounts.","users")+
        dashCard("signup-approvals","Approvals", state.signupRequests.length ? (state.signupRequests.length+" pending sign-up request"+(state.signupRequests.length===1?"":"s")+".") : "Review pending sign-up requests.", "approvals")+
        dashCard("manage-lists","Manage Lists","Edit shift/leave types, units, designations, on-call ranks and posts.","lists")+
      '</div>'+
    '</div>';
  }

  /* ============================================================
     RENDER: ROSTER GRID
  ============================================================ */
  function scheduleStatusBanner(){
    var status = state.scheduleStatus;
    if(status==="approved") return '<div class="success-banner" style="margin-bottom:14px;">Published — every member of this unit can see this schedule.</div>';
    if(status==="draft") return '<div class="error-banner" style="margin-bottom:14px;">Draft — only the coordinator and developer can see this until it\'s approved.</div>';
    return '<div class="empty-state" style="margin-bottom:14px;">No schedule has been generated for this unit and month yet.</div>';
  }

  function renderGeneratePanel(){
    var run = state.scheduleRun || { status:"none", redoCount:0, conflicts:[] };
    var isDraft = run.status==="draft";
    var conflicts = run.conflicts || [];
    return ''+
    '<div class="card" style="background:var(--surface-2); box-shadow:none; margin-bottom:16px;">'+
      '<h3 style="margin-bottom:6px; font-size:15px;">AI schedule generation'+(run.usedPlaceholder?' <span class="chip chip-amber">placeholder mode</span>':'')+'</h3>'+
      (run.usedPlaceholder ? '<p class="hint" style="color:var(--red);">No ANTHROPIC_API_KEY is configured on this server, so this used a plain rotation instead of a real AI-optimized schedule — see the README.</p>' : '')+
      (run.generatedAt ? '<p class="muted" style="font-size:12px;">Last generated '+esc(new Date(run.generatedAt).toLocaleString())+' by '+esc(run.generatedBy||"—")+' · redo #'+esc(run.redoCount||0)+'</p>' : '')+
      (run.aiNotes ? '<div class="detail-row" style="align-items:flex-start;"><div class="k">Notes</div><div style="font-size:13px;">'+esc(run.aiNotes)+'</div></div>' : '')+
      (conflicts.length ? '<div class="error-banner" style="margin-top:8px;"><b>Conflicts found — consider a redo:</b><ul style="margin:6px 0 0 18px; padding:0;">'+conflicts.map(function(c){ return '<li>'+esc(c)+'</li>'; }).join("")+'</ul></div>' : '')+
      '<div class="field" style="margin-top:10px;"><label for="gen-instructions">Extra instructions'+(isDraft?" (for the redo)":"")+'</label><textarea id="gen-instructions" placeholder="e.g. give Dr. Sharma fewer night shifts; avoid back-to-back on-calls for Dr. Iyer"></textarea></div>'+
      '<div style="display:flex; gap:8px; flex-wrap:wrap;">'+
        '<button class="btn btn-primary btn-sm" id="btn-generate-schedule" '+(state.generateBusy?"disabled":"")+'>'+(state.generateBusy?"Generating…":(isDraft?"Redo":"Generate"))+'</button>'+
        (isDraft ? '<button class="btn btn-sm" id="btn-approve-schedule" '+(state.approveBusy?"disabled":"")+'>'+(state.approveBusy?"Approving…":"Approve & publish")+'</button>' : '')+
      '</div>'+
    '</div>';
  }

  function renderRoster(){
    if(state.loading) return '<div class="empty-state">Loading roster…</div>';
    var cfg = state.config;
    var unit = state.rosterUnit;
    var month = state.rosterMonth;

    var legend = (cfg.shiftLeaveTypes||[]).map(function(t){
      return '<span class="chip chip-'+esc(t.color)+'">'+esc(t.label)+'</span>';
    }).join(" ");

    var unitPicker = state.user.role==="developer"
      ? '<div style="display:flex; align-items:center; gap:8px;"><label style="margin:0; font-size:12.5px;" for="roster-unit-select">Unit</label><select id="roster-unit-select" style="width:auto;">'+unitOptions(unit)+'</select></div>'
      : '';

    var canManage = state.canManageSchedule;
    var canDirectEdit = state.user.role==="developer";
    var showGrid = state.published || canManage;

    var body = "";
    if(!showGrid){
      body = '<div class="empty-state">This unit\'s schedule for '+esc(monthLabel(month))+' hasn\'t been published yet. Check back once your coordinator approves it.</div>';
    }else if(state.rosterPeople.length===0){
      body = '<div class="empty-state">No one is assigned to this unit yet.</div>';
    }else{
      var entryMap = {};
      state.rosterEntries.forEach(function(e){ entryMap[e.username+"|"+e.date] = e; });
      var days = daysInMonth(month);
      var dayHeaders = "";
      for(var d=1; d<=days; d++){
        dayHeaders += '<th>'+pad(d)+'<br>'+weekdayAbbrev(month,d)+'</th>';
      }
      var rows = state.rosterPeople.map(function(p){
        var cells = "";
        for(var day=1; day<=days; day++){
          var dateStr = month+"-"+pad(day);
          var entry = entryMap[p.username+"|"+dateStr];
          var typeKey = entry ? entry.typeKey : "";
          var info = typeKey ? typeInfo(typeKey) : null;
          var cls = info ? "rs-"+info.color : "";
          if(canDirectEdit){
            cells += '<td><select class="roster-select '+cls+'" data-roster-user="'+esc(p.username)+'" data-roster-date="'+dateStr+'">'+
              '<option value="">—</option>'+
              (cfg.shiftLeaveTypes||[]).map(function(t){ return '<option value="'+esc(t.key)+'" '+(t.key===typeKey?"selected":"")+'>'+esc(t.label)+'</option>'; }).join("")+
              '</select></td>';
          }else{
            cells += '<td class="roster-cell-ro '+cls+'">'+(info?esc(info.label):"—")+'</td>';
          }
        }
        var subline = roleLabel(p.role) + (p.onCallRank ? " · "+esc(p.onCallRank) : "") + (p.post && p.post!=="Other" ? " · "+esc(p.post) : "");
        return '<tr><td class="roster-name-col"><b>'+esc(p.displayName)+'</b><br><span class="muted" style="font-size:11px;">'+subline+'</span></td>'+cells+'</tr>';
      }).join("");
      body = '<div class="table-wrap"><table class="roster-table"><thead><tr><th class="roster-name-col">Person</th>'+dayHeaders+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
    }

    return ''+
    '<div class="card"><div class="section-head"><h2>Duty Roster — '+esc(unitShort(unit))+' <span class="muted" style="font-weight:400; font-size:14px;">('+esc(unitFull(unit))+')</span></h2>'+unitPicker+'</div>'+
      '<div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">'+
        '<button class="btn btn-sm" id="roster-prev-month">‹ Prev</button>'+
        '<span class="mono" style="min-width:150px; text-align:center;">'+monthLabel(month)+'</span>'+
        '<button class="btn btn-sm" id="roster-next-month">Next ›</button>'+
      '</div>'+
      (canManage ? renderGeneratePanel() : "")+
      scheduleStatusBanner()+
      '<div class="roster-legend">'+legend+'</div>'+
      '<p class="hint" style="margin-bottom:12px;">'+(canDirectEdit?"This schedule is AI-generated by the unit's coordinator. As developer you can still fix a single cell directly below if needed.":"This schedule is generated by your unit's coordinator from everyone's submitted preferences — there is no direct grid editing.")+'</p>'+
      body+
    '</div>';
  }

  async function loadRoster(){
    state.loading = true; render();
    var errMsg = null;
    try{
      var res = await dGetRoster(state.rosterUnit, state.rosterMonth);
      state.rosterUnit = res.unit; state.rosterMonth = res.month;
      state.rosterPeople = res.people; state.rosterEntries = res.entries;
      state.scheduleStatus = res.scheduleStatus; state.published = res.published;
      state.canManageSchedule = res.isCoordinatorView; state.scheduleRun = res.scheduleRun;
    }catch(e){ errMsg = e.message || "Could not load the roster."; }
    state.loading = false;
    // Guard against a stale completion: if the user has since logged out
    // (e.g. navigated away and signed in as someone else while this fetch
    // was still in flight), state.user is now null and the only valid
    // screen is the login/signup form -- calling toast()/render() here
    // would wholesale-replace that form's HTML (login fields are plain
    // uncontrolled DOM inputs, not tracked in `state`), silently wiping
    // out whatever the person had already typed. Skip both instead; the
    // fetch's actual effect (the DB write, if any) already happened.
    if(!state.user) return;
    if(errMsg) toast(errMsg); else render();
  }

  async function putRosterCell(username, date, typeKey){
    var errMsg = null;
    try{
      var entry = await dPutRosterEntry({ username: username, date: date, typeKey: typeKey });
      state.rosterEntries = state.rosterEntries.filter(function(e){ return !(e.username===username && e.date===date); });
      if(entry) state.rosterEntries.push(entry);
    }catch(e){ errMsg = e.message || "Could not save that cell."; }
    if(!state.user) return; // see loadRoster's comment above
    if(errMsg) toast(errMsg); else render();
  }

  async function generateSchedule(extraInstructions){
    state.generateBusy = true; render();
    var errMsg = null;
    try{
      var res = await dGenerateSchedule({ unit: state.rosterUnit, month: state.rosterMonth, extraInstructions: extraInstructions });
      state.scheduleRun = res.scheduleRun;
    }catch(e){ errMsg = e.message || "Could not generate the schedule."; }
    state.generateBusy = false;
    if(!state.user) return; // see loadRoster's comment above
    if(errMsg){ toast(errMsg); render(); }
    else{ toast("Schedule generated — review it below, then Approve to publish."); await loadRoster(); }
  }

  async function approveSchedule(){
    state.approveBusy = true; render();
    var errMsg = null;
    try{
      var res = await dApproveSchedule({ unit: state.rosterUnit, month: state.rosterMonth });
      state.scheduleRun = res.scheduleRun;
    }catch(e){ errMsg = e.message || "Could not approve the schedule."; }
    state.approveBusy = false;
    if(!state.user) return; // see loadRoster's comment above
    if(errMsg){ toast(errMsg); render(); }
    else{ toast("Schedule approved and published to the unit."); await loadRoster(); }
  }

  function wireRosterEvents(){
    var unitSel = el("roster-unit-select");
    if(unitSel) unitSel.onchange = function(){ state.rosterUnit = unitSel.value; loadRoster(); };
    var prev = el("roster-prev-month");
    if(prev) prev.onclick = function(){ state.rosterMonth = addMonths(state.rosterMonth, -1); loadRoster(); };
    var next = el("roster-next-month");
    if(next) next.onclick = function(){ state.rosterMonth = addMonths(state.rosterMonth, 1); loadRoster(); };
    document.querySelectorAll("[data-roster-user]").forEach(function(sel){
      sel.onchange = function(){ putRosterCell(sel.getAttribute("data-roster-user"), sel.getAttribute("data-roster-date"), sel.value || null); };
    });
    var btnGen = el("btn-generate-schedule");
    if(btnGen) btnGen.onclick = function(){ generateSchedule((el("gen-instructions")||{}).value || ""); };
    var btnApprove = el("btn-approve-schedule");
    if(btnApprove) btnApprove.onclick = approveSchedule;
  }

  /* ============================================================
     RENDER: MY PREFERENCES (leave requests + duty preferences) -- the
     only user-facing input into the AI-generated schedule now (see
     api.py's v2 permission model docstring).
  ============================================================ */
  function leaveTypeOptions(selected){
    var list = (state.config.shiftLeaveTypes||[]).filter(function(t){ return t.category==="leave"; });
    return list.map(function(t){ return '<option value="'+esc(t.key)+'" '+(t.key===selected?"selected":"")+'>'+esc(t.label)+'</option>'; }).join("");
  }
  function dutyTypeCheckboxes(name, keyList){
    var opts = (state.config.shiftLeaveTypes||[]).filter(function(t){ return t.category==="shift"||t.category==="oncall"||t.category==="off"; });
    keyList = keyList||[];
    return opts.map(function(t){
      var checked = keyList.indexOf(t.key)!==-1;
      return '<label class="chip-check"><input type="checkbox" name="'+name+'" value="'+esc(t.key)+'" '+(checked?"checked":"")+'> '+esc(t.label)+'</label>';
    }).join(" ") || '<span class="muted" style="font-size:12.5px;">No duty types configured yet.</span>';
  }

  function renderPreferences(){
    if(state.loading || !state.myLeaveRequestsLoaded || !state.myDutyPrefLoaded) return '<div class="empty-state">Loading your preferences…</div>';
    var month = state.prefMonth || currentMonthStr();
    var pref = state.myDutyPref || { preferredTypes:[], avoidTypes:[], maxConsecutiveOncalls:null, notes:"" };
    var leaveRows = (state.myLeaveRequests||[]).map(function(r){
      var t = typeInfo(r.typeKey);
      return '<tr><td>'+esc(r.startDate)+' – '+esc(r.endDate)+'</td><td><span class="chip chip-'+esc(t.color)+'">'+esc(t.label)+'</span></td><td>'+esc(r.note||"—")+'</td>'+
        '<td><button class="btn btn-sm btn-danger" data-delete-leave="'+r.id+'">Remove</button></td></tr>';
    }).join("") || '<tr><td colspan="4" class="muted">No leave requests submitted yet.</td></tr>';

    return ''+
    '<div class="card"><h2>Leave requests</h2>'+
      '<p class="muted" style="font-size:12.5px;">Submit the leave you need — your coordinator sees these when generating the schedule, and the generator will not schedule you for duty on these dates.</p>'+
      '<div class="table-wrap"><table><thead><tr><th>Dates</th><th>Type</th><th>Note</th><th></th></tr></thead><tbody>'+leaveRows+'</tbody></table></div>'+
      '<div class="row2" style="margin-top:12px;">'+
        '<div class="field" style="margin:0;"><label for="lv-start">From</label><input id="lv-start" type="date"></div>'+
        '<div class="field" style="margin:0;"><label for="lv-end">To</label><input id="lv-end" type="date"></div>'+
      '</div>'+
      '<div class="row2">'+
        '<div class="field" style="margin:0;"><label for="lv-type">Type</label><select id="lv-type">'+leaveTypeOptions(null)+'</select></div>'+
        '<div class="field" style="margin:0;"><label for="lv-note">Note (optional)</label><input id="lv-note" type="text"></div>'+
      '</div>'+
      '<button class="btn btn-primary btn-sm" id="btn-add-leave">Add leave request</button>'+
    '</div>'+
    '<div class="card"><div class="section-head"><h2>Duty preferences</h2>'+
      '<div style="display:flex; align-items:center; gap:8px;"><label style="margin:0; font-size:12.5px;" for="pref-month">Month</label><input id="pref-month" type="month" value="'+esc(month)+'"></div>'+
    '</div>'+
      '<p class="muted" style="font-size:12.5px;">Soft preferences for '+esc(monthLabel(month))+' — the schedule generator tries to honor these but they are not guaranteed, especially where they conflict with staffing needs or someone else\'s leave.</p>'+
      '<div class="field"><label>Prefer more of</label><div class="chip-check-row">'+dutyTypeCheckboxes("pref-preferred", pref.preferredTypes)+'</div></div>'+
      '<div class="field"><label>Avoid</label><div class="chip-check-row">'+dutyTypeCheckboxes("pref-avoid", pref.avoidTypes)+'</div></div>'+
      '<div class="row2">'+
        '<div class="field"><label for="pref-maxoncall">Max consecutive on-calls</label><input id="pref-maxoncall" type="number" min="0" value="'+(pref.maxConsecutiveOncalls!=null?pref.maxConsecutiveOncalls:"")+'"></div>'+
        '<div></div>'+
      '</div>'+
      '<div class="field"><label for="pref-notes">Anything else the coordinator/AI should know</label><textarea id="pref-notes" placeholder="e.g. clinic commitments, exam dates…">'+esc(pref.notes||"")+'</textarea></div>'+
      '<button class="btn btn-primary btn-sm" id="btn-save-duty-pref">Save preferences</button>'+
    '</div>';
  }

  async function loadPreferences(){
    if(!state.prefMonth) state.prefMonth = currentMonthStr();
    state.loading = true; render();
    var errMsg = null;
    try{
      state.myLeaveRequests = await dListLeaveRequests();
      state.myDutyPref = await dGetDutyPreference(state.prefMonth);
    }catch(e){ errMsg = e.message || "Could not load your preferences."; }
    state.myLeaveRequestsLoaded = true; state.myDutyPrefLoaded = true; state.loading = false;
    if(!state.user) return; // see loadRoster's comment on this same race
    if(errMsg) toast(errMsg); else render();
  }

  async function addLeaveRequest(body){
    try{ await dCreateLeaveRequest(body); toast("Leave request added."); await loadPreferences(); }
    catch(e){ toast(e.message || "Could not add leave request."); }
  }
  async function removeLeaveRequest(id){
    try{ await dDeleteLeaveRequest(id); toast("Removed."); await loadPreferences(); }
    catch(e){ toast(e.message || "Could not remove."); }
  }
  async function saveDutyPreference(){
    var preferred = Array.prototype.slice.call(document.querySelectorAll('input[name="pref-preferred"]:checked')).map(function(c){ return c.value; });
    var avoid = Array.prototype.slice.call(document.querySelectorAll('input[name="pref-avoid"]:checked')).map(function(c){ return c.value; });
    var maxV = (el("pref-maxoncall").value||"").trim();
    var body = {
      month: state.prefMonth,
      preferredTypes: preferred, avoidTypes: avoid,
      maxConsecutiveOncalls: maxV===""?null:Number(maxV),
      notes: el("pref-notes").value
    };
    var errMsg = null;
    try{ state.myDutyPref = await dPutDutyPreference(body); }
    catch(e){ errMsg = e.message || "Could not save preferences."; }
    if(!state.user) return; // see loadRoster's comment on this same race
    if(errMsg) toast(errMsg); else{ toast("Preferences saved."); render(); }
  }

  function wirePreferencesEvents(){
    var monthInp = el("pref-month");
    if(monthInp) monthInp.onchange = function(){ state.prefMonth = monthInp.value; loadPreferences(); };
    var btnAddLeave = el("btn-add-leave");
    if(btnAddLeave) btnAddLeave.onclick = function(){
      var start = el("lv-start").value, end = el("lv-end").value, typeKey = el("lv-type").value, note = el("lv-note").value;
      if(!start || !end){ toast("Pick a start and end date."); return; }
      addLeaveRequest({ startDate: start, endDate: end, typeKey: typeKey, note: note });
    };
    document.querySelectorAll("[data-delete-leave]").forEach(function(b){
      b.onclick = function(){ if(!confirm("Remove this leave request?")) return; removeLeaveRequest(+b.getAttribute("data-delete-leave")); };
    });
    var btnSavePref = el("btn-save-duty-pref");
    if(btnSavePref) btnSavePref.onclick = saveDutyPreference;
  }

  /* ============================================================
     RENDER: MY UNIT (Head of Unit's scoped role/designation/on-call-rank
     edit -- the one extra right the "Head of Unit" post grants, see
     api.py's can_edit_profile_fields).
  ============================================================ */
  function renderHouRoleFields(role, u){
    var cfg = state.config;
    return ''+
    '<div class="row2">'+
      (role==="professor" ? '<div class="field"><label for="hou-designation">Designation</label><select id="hou-designation">'+opts_(cfg.designations, u.designation||cfg.designations[0])+'</select></div>' : '<div></div>')+
      '<div class="field"><label for="hou-oncall">On-call rank</label><select id="hou-oncall">'+opts_(cfg.onCallRanks, u.onCallRank||cfg.onCallRanks[cfg.onCallRanks.length-1])+'</select></div>'+
    '</div>';
  }
  function renderUnitMemberEditForm(u){
    return ''+
    '<div class="card" style="background:var(--surface-2); box-shadow:none; margin:8px 0;">'+
      '<div class="field"><label for="hou-role">Role</label><select id="hou-role">'+
        ["postgraduate","fellow","professor"].map(function(r){ return '<option value="'+r+'" '+(r===u.role?"selected":"")+'>'+roleLabel(r)+'</option>'; }).join("")+
      '</select></div>'+
      '<div id="hou-role-fields">'+renderHouRoleFields(u.role, u)+'</div>'+
      '<div style="display:flex; gap:8px;"><button class="btn btn-primary btn-sm" id="btn-save-unit-member">Save</button><button class="btn btn-sm" id="btn-cancel-unit-member">Cancel</button></div>'+
    '</div>';
  }
  function renderUnitMembers(){
    if(state.loading || !state.unitMembersLoaded) return '<div class="empty-state">Loading…</div>';
    var rows = state.unitMembers.map(function(u){
      var isSelf = u.username===state.user.username;
      var editing = state.editingUnitMemberUsername===u.username;
      return '<tr><td>'+esc(u.displayName)+'<br><span class="muted mono" style="font-size:11px;">'+esc(u.username)+'</span></td>'+
        '<td>'+roleLabel(u.role)+'</td><td>'+(u.designation||"—")+'</td><td>'+(u.onCallRank||"—")+'</td><td>'+(u.post||"—")+'</td>'+
        '<td>'+(isSelf ? '<span class="muted" style="font-size:12px;">(you)</span>' : '<button class="btn btn-sm" data-edit-unit-member="'+esc(u.username)+'">'+(editing?"Cancel":"Edit")+'</button>')+'</td>'+
      '</tr>'+(editing ? '<tr><td colspan="6">'+renderUnitMemberEditForm(u)+'</td></tr>' : '');
    }).join("");
    return ''+
    '<div class="card"><div class="section-head"><h2>My Unit — '+esc(unitShort(state.user.unit))+'</h2></div>'+
      '<p class="hint">As Head of Unit you can edit role, designation and on-call rank for other members of your unit. Everything else — unit, post, coordinator status, account creation/deactivation — is set by the developer.</p>'+
      '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Designation</th><th>On-call rank</th><th>Post</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
    '</div>';
  }

  async function loadUnitMembers(){
    state.loading = true; render();
    var errMsg = null;
    try{ var res = await dGetRoster(state.user.unit, currentMonthStr()); state.unitMembers = res.people; }
    catch(e){ errMsg = e.message || "Could not load your unit's members."; }
    state.unitMembersLoaded = true; state.loading = false;
    if(!state.user) return; // see loadRoster's comment on this same race
    if(errMsg) toast(errMsg); else render();
  }

  async function saveUnitMemberEdit(){
    var username = state.editingUnitMemberUsername;
    var role = (el("hou-role")||{}).value;
    var body = { role: role, onCallRank: (el("hou-oncall")||{}).value };
    if(role==="professor") body.designation = (el("hou-designation")||{}).value;
    try{
      await dUpdateUser(username, body);
      state.editingUnitMemberUsername = null;
      toast("Saved.");
      await loadUnitMembers();
    }catch(e){ toast(e.message || "Could not save changes."); }
  }

  function wireUnitMembersEvents(){
    document.querySelectorAll("[data-edit-unit-member]").forEach(function(b){
      b.onclick = function(){
        var un = b.getAttribute("data-edit-unit-member");
        state.editingUnitMemberUsername = state.editingUnitMemberUsername===un ? null : un;
        render();
      };
    });
    var houRole = el("hou-role");
    if(houRole){
      var u = state.unitMembers.filter(function(x){ return x.username===state.editingUnitMemberUsername; })[0];
      houRole.onchange = function(){ var wrap=el("hou-role-fields"); if(wrap && u) wrap.innerHTML = renderHouRoleFields(houRole.value, u); };
    }
    var btnSave = el("btn-save-unit-member");
    if(btnSave) btnSave.onclick = saveUnitMemberEdit;
    var btnCancel = el("btn-cancel-unit-member");
    if(btnCancel) btnCancel.onclick = function(){ state.editingUnitMemberUsername = null; render(); };
  }

  /* ============================================================
     RENDER: MANAGE USERS (developer)
  ============================================================ */
  function renderNuRoleFields(role){
    var cfg = state.config;
    if(role==="developer") return '<p class="hint">Developer accounts have master control and don\'t belong to a unit.</p>';
    return ''+
    '<div class="row2">'+
      '<div class="field"><label for="nu-unit">Unit</label><select id="nu-unit">'+unitOptions(null)+'</select></div>'+
      (role==="professor" ? '<div class="field"><label for="nu-designation">Designation</label><select id="nu-designation">'+opts_(cfg.designations, cfg.designations[0])+'</select></div>' : '<div></div>')+
    '</div>'+
    '<div class="row2">'+
      '<div class="field"><label for="nu-oncall">On-call rank</label><select id="nu-oncall">'+opts_(cfg.onCallRanks, cfg.onCallRanks[cfg.onCallRanks.length-1])+'</select></div>'+
      '<div class="field"><label for="nu-post">Post</label><select id="nu-post">'+opts_(cfg.posts, cfg.posts[cfg.posts.length-1])+'</select></div>'+
    '</div>';
  }

  function renderCreateUserForm(){
    var role = state.newUserRole;
    return ''+
    '<div class="card" style="background:var(--surface-2); box-shadow:none;">'+
      '<div class="row2">'+
        '<div class="field"><label for="nu-displayName">Display name</label><input id="nu-displayName" type="text"></div>'+
        '<div class="field"><label for="nu-username">Username</label><input id="nu-username" type="text"></div>'+
      '</div>'+
      '<div class="row2">'+
        '<div class="field"><label for="nu-password">Password</label><input id="nu-password" type="password"></div>'+
        '<div class="field"><label for="nu-role">Role</label><select id="nu-role">'+
          ["postgraduate","fellow","professor","developer"].map(function(r){ return '<option value="'+r+'" '+(r===role?"selected":"")+'>'+roleLabel(r)+'</option>'; }).join("")+
        '</select></div>'+
      '</div>'+
      '<div id="nu-role-fields">'+renderNuRoleFields(role)+'</div>'+
      '<button class="btn btn-primary btn-sm" id="btn-create-user">Create account</button>'+
    '</div>';
  }

  function renderEuRoleFields(role, u){
    var cfg = state.config; u = u || {};
    if(role==="developer") return '<p class="hint">Developer accounts have master control and don\'t belong to a unit.</p>';
    return ''+
    '<div class="row2">'+
      '<div class="field"><label for="eu-unit">Unit</label><select id="eu-unit">'+unitOptions(u.unit)+'</select></div>'+
      (role==="professor" ? '<div class="field"><label for="eu-designation">Designation</label><select id="eu-designation">'+opts_(cfg.designations, u.designation||cfg.designations[0])+'</select></div>' : '<div></div>')+
    '</div>'+
    '<div class="row2">'+
      '<div class="field"><label for="eu-oncall">On-call rank</label><select id="eu-oncall">'+opts_(cfg.onCallRanks, u.onCallRank||cfg.onCallRanks[cfg.onCallRanks.length-1])+'</select></div>'+
      '<div class="field"><label for="eu-post">Post</label><select id="eu-post">'+opts_(cfg.posts, u.post||cfg.posts[cfg.posts.length-1])+'</select></div>'+
    '</div>';
  }

  function renderEditUserForm(){
    var u = state.devUsers.filter(function(x){ return x.username===state.editingUsername; })[0];
    if(!u) return "";
    return ''+
    '<div class="card" style="background:var(--surface-2); box-shadow:none;">'+
      '<h3 style="margin-bottom:10px; font-size:15px;">Edit '+esc(u.username)+'</h3>'+
      '<div class="row2">'+
        '<div class="field"><label for="eu-displayName">Display name</label><input id="eu-displayName" type="text" value="'+esc(u.displayName)+'"></div>'+
        '<div class="field"><label for="eu-password">New password (optional)</label><input id="eu-password" type="password" placeholder="Leave blank to keep current"></div>'+
      '</div>'+
      '<div class="field"><label for="eu-role">Role</label><select id="eu-role">'+
        ["postgraduate","fellow","professor","developer"].map(function(r){ return '<option value="'+r+'" '+(r===u.role?"selected":"")+'>'+roleLabel(r)+'</option>'; }).join("")+
      '</select></div>'+
      '<div id="eu-role-fields">'+renderEuRoleFields(u.role, u)+'</div>'+
      '<div style="display:flex; gap:8px; margin-top:10px;">'+
        '<button class="btn btn-primary btn-sm" id="btn-save-user">Save changes</button>'+
        '<button class="btn btn-sm" id="btn-cancel-edit-user">Cancel</button>'+
      '</div>'+
    '</div>';
  }

  function renderManageUsers(){
    if(state.loading || !state.devUsersLoaded) return '<div class="empty-state">Loading users…</div>';
    var rows = state.devUsers.map(function(u){
      var statusChip = u.approvalStatus==="pending" ? '<span class="chip chip-amber">Pending</span>'
        : (u.active ? '<span class="chip chip-green">Active</span>' : '<span class="chip chip-red">Deactivated</span>');
      var canCoordinate = u.role!=="developer" && u.unit;
      return '<tr>'+
        '<td>'+esc(u.displayName)+'<br><span class="muted mono" style="font-size:11px;">'+esc(u.username)+'</span></td>'+
        '<td>'+roleLabel(u.role)+'</td>'+
        '<td>'+(u.unit ? unitShort(u.unit) : "—")+'</td>'+
        '<td>'+(u.designation||"—")+'</td>'+
        '<td>'+(u.onCallRank||"—")+'</td>'+
        '<td>'+(u.post||"—")+'</td>'+
        '<td>'+(u.isCoordinator ? '<span class="chip chip-blue">Coordinator</span>' : "—")+'</td>'+
        '<td>'+statusChip+'</td>'+
        '<td>'+
          '<button class="btn btn-sm" data-edit-user="'+esc(u.username)+'">Edit</button> '+
          (canCoordinate ? '<button class="btn btn-sm" data-toggle-coordinator="'+esc(u.username)+'" data-coord="'+(u.isCoordinator?"1":"0")+'">'+(u.isCoordinator?"Remove coordinator":"Make coordinator")+'</button> ' : '')+
          '<button class="btn btn-sm" data-toggle-active="'+esc(u.username)+'" data-active="'+(u.active?"1":"0")+'">'+(u.active?"Deactivate":"Reactivate")+'</button> '+
          (u.username!==state.user.username ? '<button class="btn btn-sm btn-danger" data-delete-user="'+esc(u.username)+'">Delete</button>' : '')+
        '</td>'+
      '</tr>';
    }).join("");
    return ''+
    '<div class="card"><div class="section-head"><h2>Users</h2><button class="btn btn-primary btn-sm" id="btn-show-create-user">'+(state.showCreateUserForm?"Cancel":"+ New account")+'</button></div>'+
      '<p class="hint">Coordinator is independent of role, post and designation — it\'s the sole gate on generating/approving a unit\'s AI schedule (see Roster). "Head of Unit" is separate: it lets that person edit role/designation/on-call rank for others in their own unit (My Unit).</p>'+
      (state.showCreateUserForm ? renderCreateUserForm() : "")+
      (state.editingUsername ? renderEditUserForm() : "")+
      '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Unit</th><th>Designation</th><th>On-call rank</th><th>Post</th><th>Coordinator</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
    '</div>';
  }

  async function loadDevUsers(){
    state.loading = true; render();
    var errMsg = null;
    try{ state.devUsers = await dListUsers(); }catch(e){ errMsg = e.message || "Could not load users."; }
    state.devUsersLoaded = true; state.loading = false;
    if(!state.user) return; // see loadRoster's comment on this same race
    if(errMsg) toast(errMsg); else render();
  }

  async function createUser(fields){
    if((fields.username||"").length < 3){ toast("Username must be at least 3 characters."); return; }
    if((fields.password||"").length < 8){ toast("Password must be at least 8 characters."); return; }
    try{
      await dCreateUser({
        username: cleanUsername(fields.username), password: fields.password, role: fields.role, displayName: fields.displayName,
        unit: fields.unit, designation: fields.designation, onCallRank: fields.onCallRank, post: fields.post
      });
      state.showCreateUserForm = false;
      toast("Account created.");
      await loadDevUsers();
    }catch(e){ toast(e.message || "Could not create account."); }
  }

  async function saveEditedUser(){
    var username = state.editingUsername;
    var role = (el("eu-role")||{}).value;
    var body = { displayName: el("eu-displayName").value, role: role };
    if(role!=="developer"){
      body.unit = (el("eu-unit")||{}).value;
      body.onCallRank = (el("eu-oncall")||{}).value;
      body.post = (el("eu-post")||{}).value;
      if(role==="professor") body.designation = (el("eu-designation")||{}).value;
    }
    var pw = (el("eu-password")||{}).value;
    if(pw) body.password = pw;
    try{
      await dUpdateUser(username, body);
      state.editingUsername = null;
      toast("Saved.");
      await loadDevUsers();
    }catch(e){ toast(e.message || "Could not save changes."); render(); }
  }

  async function toggleUserActive(username, newActive){
    try{ await dUpdateUser(username, { active: newActive }); toast(newActive?"Reactivated.":"Deactivated."); await loadDevUsers(); }
    catch(e){ toast(e.message || "Could not update account."); }
  }

  async function toggleCoordinator(username, newVal){
    try{ await dUpdateUser(username, { isCoordinator: newVal }); toast(newVal?"Now this unit's schedule coordinator.":"Coordinator removed."); await loadDevUsers(); }
    catch(e){ toast(e.message || "Could not update account."); }
  }

  async function deleteUserAction(username){
    try{ await dDeleteUser(username); toast("Deleted."); await loadDevUsers(); }
    catch(e){ toast(e.message || "Could not delete account."); }
  }

  function wireManageUsersEvents(){
    var showCreate = el("btn-show-create-user");
    if(showCreate) showCreate.onclick = function(){ state.showCreateUserForm = !state.showCreateUserForm; state.editingUsername = null; render(); };

    var nuRole = el("nu-role");
    if(nuRole) nuRole.onchange = function(){ var wrap=el("nu-role-fields"); if(wrap) wrap.innerHTML = renderNuRoleFields(nuRole.value); };
    var btnCreate = el("btn-create-user");
    if(btnCreate) btnCreate.onclick = function(){
      var role = (el("nu-role")||{}).value || state.newUserRole;
      createUser({
        displayName: el("nu-displayName").value, username: el("nu-username").value, password: el("nu-password").value, role: role,
        unit: (el("nu-unit")||{}).value, designation: (el("nu-designation")||{}).value,
        onCallRank: (el("nu-oncall")||{}).value, post: (el("nu-post")||{}).value
      });
    };

    document.querySelectorAll("[data-edit-user]").forEach(function(b){
      b.onclick = function(){ state.editingUsername = b.getAttribute("data-edit-user"); state.showCreateUserForm = false; render(); };
    });
    var euRole = el("eu-role");
    if(euRole){
      var u = state.devUsers.filter(function(x){ return x.username===state.editingUsername; })[0];
      euRole.onchange = function(){ var wrap=el("eu-role-fields"); if(wrap) wrap.innerHTML = renderEuRoleFields(euRole.value, u); };
    }
    var btnSaveUser = el("btn-save-user"); if(btnSaveUser) btnSaveUser.onclick = saveEditedUser;
    var btnCancelEdit = el("btn-cancel-edit-user"); if(btnCancelEdit) btnCancelEdit.onclick = function(){ state.editingUsername = null; render(); };

    document.querySelectorAll("[data-toggle-active]").forEach(function(b){
      b.onclick = function(){ var username=b.getAttribute("data-toggle-active"); var active=b.getAttribute("data-active")==="1"; toggleUserActive(username, !active); };
    });
    document.querySelectorAll("[data-toggle-coordinator]").forEach(function(b){
      b.onclick = function(){ var username=b.getAttribute("data-toggle-coordinator"); var coord=b.getAttribute("data-coord")==="1"; toggleCoordinator(username, !coord); };
    });
    document.querySelectorAll("[data-delete-user]").forEach(function(b){
      b.onclick = function(){ var username=b.getAttribute("data-delete-user"); if(!confirm("Delete "+username+"'s account? This cannot be undone.")) return; deleteUserAction(username); };
    });
  }

  /* ============================================================
     RENDER: SIGNUP APPROVALS (developer)
  ============================================================ */
  function renderSignupApprovals(){
    if(state.loading || !state.signupRequestsLoaded) return '<div class="empty-state">Loading…</div>';
    if(!state.signupRequests.length) return '<div class="card"><div class="empty-state">No pending sign-up requests.</div></div>';
    var rows = state.signupRequests.map(function(u){
      return '<tr><td>'+esc(u.displayName)+'<br><span class="mono muted" style="font-size:11px;">'+esc(u.username)+'</span></td>'+
        '<td>'+roleLabel(u.role)+'</td><td>'+(u.unit?unitShort(u.unit):"—")+'</td><td>'+(u.designation||"—")+'</td>'+
        '<td><button class="btn btn-sm btn-primary" data-approve-signup="'+esc(u.username)+'">Approve</button> <button class="btn btn-sm btn-danger" data-reject-signup="'+esc(u.username)+'">Reject</button></td></tr>';
    }).join("");
    return '<div class="card"><h2>Pending sign-up requests</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Unit</th><th>Designation</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  }

  async function loadSignupRequests(){
    state.loading = true; render();
    var errMsg = null;
    try{ state.signupRequests = await dListSignupRequests(); }catch(e){ errMsg = e.message || "Could not load requests."; }
    state.signupRequestsLoaded = true; state.loading = false;
    if(!state.user) return; // see loadRoster's comment on this same race
    if(errMsg) toast(errMsg); else render();
  }
  async function approveSignup(username){
    try{ await dApproveSignup(username); toast("Approved."); await loadSignupRequests(); }catch(e){ toast(e.message || "Could not approve."); }
  }
  async function rejectSignup(username){
    try{ await dRejectSignup(username); toast("Rejected."); await loadSignupRequests(); }catch(e){ toast(e.message || "Could not reject."); }
  }
  function wireSignupApprovalsEvents(){
    document.querySelectorAll("[data-approve-signup]").forEach(function(b){ b.onclick=function(){ approveSignup(b.getAttribute("data-approve-signup")); }; });
    document.querySelectorAll("[data-reject-signup]").forEach(function(b){
      b.onclick=function(){ if(!confirm("Reject and delete this sign-up request? They will need to sign up again.")) return; rejectSignup(b.getAttribute("data-reject-signup")); };
    });
  }

  /* ============================================================
     RENDER: MANAGE LISTS (developer) -- master lists
  ============================================================ */
  var SLT_CATEGORIES = ["shift","oncall","off","leave"];
  var SLT_COLORS = ["teal","violet","amber","grey","green","red","blue"];
  var SIMPLE_LISTS = [
    { key:"designations", title:"Designations", hint:"Professor sub-designations, offered when a Professor account is created or edited." },
    { key:"onCallRanks", title:"On-call ranks", hint:"The on-call hierarchy shown on every unit member's profile." },
    { key:"posts", title:"Posts", hint:"Organizational tag only — does not grant any extra edit rights on the roster." }
  ];

  function renderShiftLeaveTypesSection(){
    var list = state.config.shiftLeaveTypes || [];
    var rows = list.map(function(t,i){
      return '<div class="proc-opt" style="display:grid; grid-template-columns:110px 1fr 110px 110px 34px; gap:8px; align-items:center; cursor:default;">'+
        '<span class="mono muted" style="font-size:11px;">'+esc(t.key)+'</span>'+
        '<input type="text" data-slt-label="'+i+'" value="'+esc(t.label)+'">'+
        '<select data-slt-category="'+i+'">'+SLT_CATEGORIES.map(function(c){ return '<option value="'+c+'" '+(c===t.category?"selected":"")+'>'+c+'</option>'; }).join("")+'</select>'+
        '<select data-slt-color="'+i+'">'+SLT_COLORS.map(function(c){ return '<option value="'+c+'" '+(c===t.color?"selected":"")+'>'+c+'</option>'; }).join("")+'</select>'+
        '<button class="btn btn-sm btn-danger" data-slt-remove="'+i+'">✕</button>'+
      '</div>';
    }).join("");
    return '<div class="card"><h2 style="font-size:15px;">Shift &amp; Leave Types</h2>'+
      '<p class="muted" style="font-size:12.5px; margin-bottom:12px;">These are the choices in every roster cell\'s dropdown. Change a label, category or color and it saves as you leave the field — the key stays fixed once created so existing roster entries keep pointing at the right type.</p>'+
      '<div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;">'+rows+'</div>'+
      '<div style="display:grid; grid-template-columns:1fr 110px 110px auto; gap:8px;">'+
        '<input type="text" id="new-slt-label" placeholder="New type label, e.g. Night Duty">'+
        '<select id="new-slt-category">'+SLT_CATEGORIES.map(function(c){ return '<option value="'+c+'">'+c+'</option>'; }).join("")+'</select>'+
        '<select id="new-slt-color">'+SLT_COLORS.map(function(c){ return '<option value="'+c+'">'+c+'</option>'; }).join("")+'</select>'+
        '<button class="btn btn-sm btn-primary" id="add-slt">Add type</button>'+
      '</div>'+
    '</div>';
  }

  function renderUnitsSection(){
    var units = state.config.units || [];
    var rows = units.map(function(u,i){
      return '<div class="proc-opt" style="display:grid; grid-template-columns:90px 1fr 34px; gap:8px; align-items:center; cursor:default;">'+
        '<input type="text" data-unit-shortform="'+i+'" value="'+esc(u.shortForm)+'">'+
        '<input type="text" data-unit-fullname="'+i+'" value="'+esc(u.fullName)+'">'+
        '<button class="btn btn-sm btn-danger" data-unit-remove="'+i+'">✕</button>'+
      '</div>';
    }).join("");
    return '<div class="card"><h2 style="font-size:15px;">Units (ENT 1–5)</h2>'+
      '<p class="muted" style="font-size:12.5px; margin-bottom:12px;">The master list of units this app covers. Removing a unit here does not touch any account or roster entry already pointing at it — it just stops appearing as a choice for new ones.</p>'+
      '<div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;">'+rows+'</div>'+
      '<div style="display:grid; grid-template-columns:110px 1fr auto; gap:8px;">'+
        '<input type="text" id="new-unit-shortform" placeholder="e.g. ENT 6">'+
        '<input type="text" id="new-unit-fullname" placeholder="Full name, e.g. Oto-laryngology Unit 6">'+
        '<button class="btn btn-sm btn-primary" id="add-unit">Add unit</button>'+
      '</div>'+
    '</div>';
  }

  function renderSimpleListSection(spec){
    var items = state.config[spec.key] || [];
    var rows = items.map(function(v,i){
      return '<div class="proc-opt" style="display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:default;"><span>'+esc(v)+'</span><button class="btn btn-sm btn-danger" data-simple-remove="'+spec.key+'" data-idx="'+i+'">Remove</button></div>';
    }).join("") || '<p class="muted" style="font-size:13px;">Nothing here yet — add the first one below.</p>';
    return '<div class="card"><h2 style="font-size:15px;">'+esc(spec.title)+'</h2>'+
      '<p class="muted" style="font-size:12.5px; margin-top:-8px; margin-bottom:12px;">'+esc(spec.hint)+'</p>'+
      '<div style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">'+rows+'</div>'+
      '<div style="display:flex; gap:8px;">'+
        '<input type="text" id="newitem-'+spec.key+'" placeholder="Add an option…" style="flex:1;">'+
        '<button class="btn btn-sm btn-primary" data-simple-add="'+spec.key+'">Add</button>'+
      '</div>'+
    '</div>';
  }

  function renderManageLists(){
    return renderShiftLeaveTypesSection() + renderUnitsSection() + SIMPLE_LISTS.map(renderSimpleListSection).join("");
  }

  async function saveConfigList(key, list){
    var errMsg = null;
    try{
      var patch = {}; patch[key] = list;
      state.config = await dUpdateConfig(patch);
    }catch(e){ errMsg = e.message || "Could not save."; }
    if(!state.user) return; // see loadRoster's comment on this same race
    if(errMsg) toast(errMsg); else toast("Saved.");
  }
  function updateShiftLeaveType(i, field, value){
    var list = (state.config.shiftLeaveTypes||[]).slice();
    list[i] = Object.assign({}, list[i]); list[i][field] = value;
    saveConfigList("shiftLeaveTypes", list);
  }
  function removeShiftLeaveType(i){
    var list = (state.config.shiftLeaveTypes||[]).slice(); list.splice(i,1);
    saveConfigList("shiftLeaveTypes", list);
  }
  function addShiftLeaveType(label, category, color){
    var existingKeys = (state.config.shiftLeaveTypes||[]).map(function(t){ return t.key; });
    var key = uniqueSlug(label, existingKeys);
    var list = (state.config.shiftLeaveTypes||[]).concat([{ key:key, label:label, category:category, color:color }]);
    saveConfigList("shiftLeaveTypes", list);
  }
  function updateUnit(i, field, value){
    var list = (state.config.units||[]).slice();
    list[i] = Object.assign({}, list[i]); list[i][field] = value;
    saveConfigList("units", list);
  }
  function removeUnit(i){
    var list = (state.config.units||[]).slice(); list.splice(i,1);
    saveConfigList("units", list);
  }
  function addUnit(shortForm, fullName){
    var existingKeys = (state.config.units||[]).map(function(u){ return u.key; });
    var key = uniqueSlug(shortForm, existingKeys);
    var list = (state.config.units||[]).concat([{ key:key, shortForm:shortForm, fullName:fullName }]);
    saveConfigList("units", list);
  }

  function wireManageListsEvents(){
    document.querySelectorAll("[data-slt-label]").forEach(function(inp){ inp.onchange=function(){ updateShiftLeaveType(+inp.getAttribute("data-slt-label"), "label", inp.value); }; });
    document.querySelectorAll("[data-slt-category]").forEach(function(sel){ sel.onchange=function(){ updateShiftLeaveType(+sel.getAttribute("data-slt-category"), "category", sel.value); }; });
    document.querySelectorAll("[data-slt-color]").forEach(function(sel){ sel.onchange=function(){ updateShiftLeaveType(+sel.getAttribute("data-slt-color"), "color", sel.value); }; });
    document.querySelectorAll("[data-slt-remove]").forEach(function(b){
      b.onclick=function(){ if(!confirm("Remove this type? Already-logged roster entries keep the old value as plain text.")) return; removeShiftLeaveType(+b.getAttribute("data-slt-remove")); };
    });
    var addSlt = el("add-slt");
    if(addSlt) addSlt.onclick = function(){
      var label = (el("new-slt-label").value||"").trim();
      if(!label){ toast("Enter a label first."); return; }
      addShiftLeaveType(label, el("new-slt-category").value, el("new-slt-color").value);
    };

    document.querySelectorAll("[data-unit-shortform]").forEach(function(inp){ inp.onchange=function(){ updateUnit(+inp.getAttribute("data-unit-shortform"), "shortForm", inp.value); }; });
    document.querySelectorAll("[data-unit-fullname]").forEach(function(inp){ inp.onchange=function(){ updateUnit(+inp.getAttribute("data-unit-fullname"), "fullName", inp.value); }; });
    document.querySelectorAll("[data-unit-remove]").forEach(function(b){
      b.onclick=function(){ if(!confirm("Remove this unit? Accounts already assigned to it keep the old unit key; it just stops appearing as a choice for new ones.")) return; removeUnit(+b.getAttribute("data-unit-remove")); };
    });
    var addUnitBtn = el("add-unit");
    if(addUnitBtn) addUnitBtn.onclick = function(){
      var shortForm = (el("new-unit-shortform").value||"").trim();
      var fullName = (el("new-unit-fullname").value||"").trim();
      if(!shortForm || !fullName){ toast("Enter both a short form and a full name."); return; }
      addUnit(shortForm, fullName);
    };

    document.querySelectorAll("[data-simple-remove]").forEach(function(b){
      b.onclick=function(){
        var key=b.getAttribute("data-simple-remove"); var idx=+b.getAttribute("data-idx");
        var list=(state.config[key]||[]).slice(); list.splice(idx,1);
        saveConfigList(key, list);
      };
    });
    document.querySelectorAll("[data-simple-add]").forEach(function(b){
      b.onclick=function(){
        var key=b.getAttribute("data-simple-add"); var input=el("newitem-"+key); var value=(input.value||"").trim();
        if(!value) return;
        if((state.config[key]||[]).indexOf(value)!==-1){ toast("Already in the list."); return; }
        var list=(state.config[key]||[]).concat([value]);
        saveConfigList(key, list);
      };
    });
  }

  /* ============================================================
     RENDER: ACCOUNT
  ============================================================ */
  function renderAccount(){
    var u = state.user;
    return ''+
    '<div class="card"><h2>My Account</h2>'+
      '<div class="detail-row"><div class="k">Username</div><div>'+esc(u.username)+'</div></div>'+
      '<div class="detail-row"><div class="k">Display name</div><div>'+esc(u.displayName)+'</div></div>'+
      '<div class="detail-row"><div class="k">Role</div><div>'+roleLabel(u.role)+'</div></div>'+
      (u.unit ? '<div class="detail-row"><div class="k">Unit</div><div>'+esc(unitShort(u.unit))+' — '+esc(unitFull(u.unit))+'</div></div>' : '')+
      (u.designation ? '<div class="detail-row"><div class="k">Designation</div><div>'+esc(u.designation)+'</div></div>' : '')+
      (u.onCallRank ? '<div class="detail-row"><div class="k">On-call rank</div><div>'+esc(u.onCallRank)+'</div></div>' : '')+
      (u.post ? '<div class="detail-row"><div class="k">Post</div><div>'+esc(u.post)+'</div></div>' : '')+
      '<p class="hint" style="margin-top:10px;">Profile fields (unit, designation, on-call rank, post) are set by the developer — ask them for changes.</p>'+
    '</div>'+
    '<div class="card"><h2>Change password</h2>'+
      (state.pwError ? '<div class="error-banner">'+esc(state.pwError)+'</div>' : '')+
      '<div class="field"><label for="pw-old">Current password</label><input id="pw-old" type="password"></div>'+
      '<div class="row2">'+
        '<div class="field"><label for="pw-new">New password</label><input id="pw-new" type="password"></div>'+
        '<div class="field"><label for="pw-confirm">Confirm new password</label><input id="pw-confirm" type="password"></div>'+
      '</div>'+
      '<button class="btn btn-primary btn-sm" id="btn-change-password" '+(state.pwBusy?"disabled":"")+'>'+(state.pwBusy?"Saving…":"Change password")+'</button>'+
    '</div>';
  }
  function wireAccountEvents(){
    var btn = el("btn-change-password");
    if(btn) btn.onclick = function(){ doChangePassword(el("pw-old").value, el("pw-new").value, el("pw-confirm").value); };
  }

  /* ============================================================
     RENDER + LOAD DISPATCH
  ============================================================ */
  // Sets the roster view's unit/month defaults synchronously, so a render()
  // that runs before loadForView()'s async fetch resolves never sees a null
  // rosterMonth/rosterUnit (daysInMonth/monthLabel/addMonths all call
  // .split("-") on it, which throws on null and -- because that throw
  // happens inside render(), before app.innerHTML is reassigned -- silently
  // leaves the PREVIOUS view on screen instead of the roster grid).
  function ensureRosterDefaults(){
    if(!state.rosterMonth) state.rosterMonth = currentMonthStr();
    if(!state.rosterUnit) state.rosterUnit = state.user.role==="developer" ? ((state.config.units||[])[0]||{}).key : state.user.unit;
  }

  function loadForView(){
    if(state.view==="roster"){
      ensureRosterDefaults();
      loadRoster();
    }else if(state.view==="preferences"){
      loadPreferences();
    }else if(state.view==="unit-members"){
      loadUnitMembers();
    }else if(state.view==="manage-users"){
      loadDevUsers();
    }else if(state.view==="signup-approvals"){
      loadSignupRequests();
    }
  }

  function render(){
    var app = el("app");
    if(!app) return;
    if(!state.capReady){
      app.innerHTML = '<div class="center-shell"><div class="auth-card" style="text-align:center;"><div class="auth-eyebrow">Loading</div><h1 style="font-size:20px;">Opening the roster…</h1></div></div>';
      return;
    }
    if(!state.user){
      var mode = state.authMode;
      app.innerHTML = mode==="signup" ? renderSignup() : (mode==="dev-login" ? renderDevLogin() : (mode==="forgot" ? renderForgot() : (mode==="signup-pending" ? renderSignupPending() : renderLogin())));
      wireAuthEvents();
      return;
    }
    var inner = "";
    if(state.view==="dashboard") inner = state.user.role==="developer" ? renderDashboardDeveloper() : renderDashboardUnit();
    else if(state.view==="roster") inner = renderRoster();
    else if(state.view==="preferences") inner = renderPreferences();
    else if(state.view==="unit-members") inner = renderUnitMembers();
    else if(state.view==="manage-users") inner = renderManageUsers();
    else if(state.view==="signup-approvals") inner = renderSignupApprovals();
    else if(state.view==="manage-lists") inner = renderManageLists();
    else if(state.view==="account") inner = renderAccount();
    app.innerHTML = renderShell(inner);
    wireShellEvents();
  }

  function wireShellEvents(){
    document.querySelectorAll("[data-nav]").forEach(function(b){
      b.onclick = function(){
        state.mobileNavOpen=false; state.view=b.getAttribute("data-nav");
        if(state.view==="roster") ensureRosterDefaults();
        render(); loadForView();
      };
    });
    var navToggle = el("btn-nav-toggle"); if(navToggle) navToggle.onclick = function(){ state.mobileNavOpen=!state.mobileNavOpen; render(); };
    var logout = el("btn-logout"); if(logout) logout.onclick = doLogout;

    wireRosterEvents();
    wirePreferencesEvents();
    wireUnitMembersEvents();
    wireManageUsersEvents();
    wireSignupApprovalsEvents();
    wireManageListsEvents();
    wireAccountEvents();
  }

  boot();
})();
