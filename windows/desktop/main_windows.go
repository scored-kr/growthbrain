package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
)

const (
	banner = 100 + iota
	notices
	passwordLabel
	password
	repeatLabel
	repeat
	openVault
	pageLabel
	pages
	lock
	routeLabel
	routeStart
	routeStop
	signIn
	endpoint
	copyURL
	chat
	claude
	scopeLabel
	scope
	newProjectLabel
	newProject
	createProject
	keyLabel
	key
	valueLabel
	value
	save
	requestLabel
	requests
	requestDetails
	approvalScopeLabel
	approvalScope
	allow
	deny
	grantLabel
	grants
	revoke
	captureLabel
	capture
	chatHelp
	claudeHelp
	reconnectHelp
	initialMode
	chooseBackup
	backupSelected
	chooseRecovery
	recoverySelected
	backupHint
	exportBackup
	recoveryHint
	recoveryPassword
	issueRecovery
)

var controller *child
var s state
var known, busy, offline, inModal bool
var actionGeneration uint64
var pending, queued command

type desktopReply struct {
	reply
	generation uint64
}

var responses = make(chan desktopReply, 8)
var notice string

func isCombo(id int) bool {
	return id == previewScope || id == initialMode || id == key || id == pages || id == scope || id == requests || id == approvalScope || id == grants
}
func createControls() {
	createAccountControls()
	label := func(id int, t string) { newControl(id, "STATIC", t, 0x80, 0) } // SS_NOPREFIX
	edit := func(id int, flags uintptr) { newControl(id, "EDIT", "", 0x10000|flags, 0x200) }
	button := func(id int, t string) { newControl(id, "BUTTON", t, 0x10000, 0) }
	combo := func(id int) { newControl(id, "COMBOBOX", "", 0x10000|0x00200000|3, 0) }
	label(banner, "")
	label(notices, "")
	label(passwordLabel, "금고 비밀번호 (12자 이상)")
	edit(password, 0x80|0x20)
	label(repeatLabel, "비밀번호 확인")
	edit(repeat, 0x80|0x20)
	button(openVault, "금고 열기")
	label(pageLabel, "금고 관리")
	combo(pages)
	combo(initialMode)
	updateList(initialMode, []option{{"create", "새 금고 만들기"}, {"restore", "백업과 기존 비밀번호로 복원"}, {"recover", "백업과 복구 파일로 새 비밀번호 설정"}}, true)
	button(chooseBackup, "암호화 백업 파일 선택")
	button(chooseRecovery, "복구 파일 선택")
	edit(backupSelected, 0x80|0x800)
	edit(recoverySelected, 0x80|0x800)
	label(backupHint, "암호화 백업은 현재 프로젝트와 기억을 보관합니다. 내 Windows 프로필의 개인 폴더에 새 파일 이름으로 저장하세요. 금고가 없는 새 Windows 프로필에서 복원할 수 있습니다.")
	button(exportBackup, "암호화 백업 저장")
	label(recoveryHint, "비밀번호를 잊었을 때 사용할 복구 파일을 발급하려면 현재 금고 비밀번호를 다시 입력하세요. 발급 후 새로운 암호화 백업을 만들어 두 파일을 따로 보관하세요.")
	edit(recoveryPassword, 0x80|0x20)
	send.Call(controls[recoveryPassword], 0xc5, 1024, 0)
	button(issueRecovery, "복구 파일 발급")
	updateList(pages, legacyPages, true)
	button(lock, "금고 잠그기")
	label(routeLabel, "")
	button(routeStart, "공개 연결 시작")
	button(routeStop, "공개 연결 중지")
	button(signIn, "Tailscale 연결 설정 열기")
	edit(endpoint, 0x80|0x800)
	button(copyURL, "서비스에 등록할 주소 복사")
	button(chat, "ChatGPT 앱 설정 열기")
	button(claude, "Claude 커넥터 설정 열기")
	button(chatHelp, "ChatGPT 공식 연결 안내")
	button(claudeHelp, "Claude 공식 연결 안내")
	button(reconnectHelp, "잠금·재시작 후 다시 연결하는 방법")
	label(scopeLabel, "저장할 범위")
	combo(scope)
	label(newProjectLabel, "새 프로젝트 이름")
	edit(newProject, 0x80)
	button(createProject, "프로젝트 만들기")
	label(keyLabel, "기억 항목")
	newControl(key, "COMBOBOX", "", 0x10000|0x00200000|2, 0)
	updateList(key, []option{{"output.format", "답변 형식"}, {"style.tone", "어조"}, {"language", "언어"}, {"campaign.channel", "캠페인 채널"}, {"project.goal", "프로젝트 목표"}, {"project.budget", "예산"}}, true)
	label(valueLabel, "AI가 반영할 내용")
	edit(value, 0x80)
	button(save, "기억 검토 후 저장")
	label(requestLabel, "연결 요청을 선택하세요. 브라우저에 표시된 요청 번호와 대조하세요.")
	combo(requests)
	edit(requestDetails, 0x800|4|0x200000|0x40)
	label(approvalScopeLabel, "서비스가 읽을 범위")
	combo(approvalScope)
	button(allow, "내용 확인 후 읽기 승인")
	button(deny, "요청 거절")
	label(grantLabel, "승인한 연결")
	combo(grants)
	button(revoke, "선택한 연결 철회")
	label(captureLabel, "수집을 원하는 사이트에서만 확장을 사용하세요. 아래 버튼을 누르면 이 사용자의 Chrome에 기기 연결을 등록하고 확장 폴더를 엽니다. Chrome 확장 관리에서 허용된 경우에만 폴더를 로드하고, 확장 팝업에서 사이트·프로젝트별로 수집을 승인하세요.")
	button(capture, "Chrome 수집 연결 준비")
	send.Call(controls[password], 0xc5, 1024, 0)
	send.Call(controls[repeat], 0xc5, 1024, 0)
	send.Call(controls[newProject], 0xc5, 200, 0)
	send.Call(controls[key], 0x141, 80, 0)
	send.Call(controls[value], 0xc5, 2000, 0)
}
func ids(items ...int) []row {
	out := make([]row, 0, len(items))
	for _, id := range items {
		height := 36
		switch id {
		case passwordLabel, repeatLabel, pageLabel, scopeLabel, newProjectLabel, keyLabel, valueLabel, grantLabel, approvalScopeLabel:
			height = 24
		case routeLabel:
			height = 100
		case accountMessage:
			height = 70
		case previewText:
			height = 156
		case requestLabel:
			height = 54
		case requestDetails, captureLabel, backupHint, recoveryHint, purgeMessage:
			height = 116
		case banner, notices:
			height = 48
		}
		out = append(out, row{id, height})
	}
	return out
}
func routeText(w webState) string {
	switch w.State {
	case "ready":
		return "서비스 설정에서 아래 주소를 추가하고 OAuth로 로그인하세요. ChatGPT는 플러그인 추가, Claude는 커넥터 추가를 선택하세요. 그런 다음 이 앱의 ‘연결 승인·철회’로 돌아오세요."
	case "starting":
		if validSignIn(w.SignInURL) {
			return "Tailscale에서 내 기기의 공개 연결 경로를 승인하세요. 완료하면 앱에서 준비 상태를 확인합니다."
		}
		return "기기에서 HTTPS 연결을 준비하고 있습니다. 인터넷 연결을 유지하세요."
	case "unavailable":
		return explain(w.Error)
	default:
		return "ChatGPT와 Claude가 열린 금고에 접근할 HTTPS 주소를 준비합니다. 처음에는 Tailscale의 계정 승인 화면이 열릴 수 있습니다."
	}
}
func render(reset bool) {
	if reset {
		scrollOffset = 0
	}
	rows = ids(banner)
	if notice != "" {
		put(notices, notice)
		rows = append(rows, ids(notices)...)
	}
	if offline || !known {
		if offline {
			put(banner, explain("DEVICE_UNAVAILABLE"))
		} else {
			put(banner, "Growth Brain을 시작하고 있습니다.")
		}
	} else if busy && (pending["op"] == "lock" || pending["op"] == "accountLogout" || pending["op"] == "accountSuspend") {
		put(banner, "기억 접근과 읽기 연결을 종료하고 있습니다.")
	} else if !s.Unlocked && !legacyMode {
		renderSignIn()
	} else if !s.Unlocked {
		rows = append(rows, ids(returnToSignIn)...)
		mode := recoveryMode()
		label := "금고 만들기"
		note := "이 기기의 금고를 만드는 방법을 선택하세요."
		passwordTitle := "새 금고 비밀번호 (12자 이상)"
		if !s.Exists {
			rows = append(rows, recoveryRows(mode)...)
		}
		switch mode {
		case "unlock":
			label = "금고 잠금 해제"
			note = "금고가 잠겨 있습니다. 이 기기에서 비밀번호를 입력하세요."
			passwordTitle = "현재 금고 비밀번호"
		case "restore":
			label = "백업 복원"
			note = "백업을 만들 때의 비밀번호로 금고를 복원합니다."
			passwordTitle = "백업을 만들 때의 비밀번호"
		case "recover":
			label = "새 비밀번호로 복원"
			note = "해당 복구 파일 발급 후 생성한 백업을 선택하고 새 비밀번호를 정하세요."
		}
		put(banner, note)
		put(openVault, label)
		put(passwordLabel, passwordTitle)
		rows = append(rows, ids(passwordLabel, password)...)
		if mode == "create" || mode == "recover" {
			rows = append(rows, ids(repeatLabel, repeat)...)
		}
		rows = append(rows, ids(openVault)...)
	} else {
		put(banner, "금고가 열려 있습니다. 앱을 닫거나 잠그면 읽기 연결이 종료됩니다.")
		if s.Account.SignedIn {
			put(banner, s.Account.Email+" · "+syncDescription(s.Account))
			put(pageLabel, "내 작업")
			updateList(pages, accountPages, true)
			rows = append(rows, ids(pageLabel, pages)...)
		} else {
			put(pageLabel, "금고 관리")
			updateList(pages, legacyPages, true)
			rows = append(rows, ids(lock, pageLabel, pages)...)
		}
		projectOptions := []option{{"", "공통 기억만"}}
		for _, p := range s.Projects {
			projectOptions = append(projectOptions, option{p.ID, "공통 + " + p.Name})
		}
		updateList(scope, projectOptions, true)
		updateList(approvalScope, projectOptions, true)
		ro := make([]option, 0, len(s.Web.Requests))
		for _, r := range s.Web.Requests {
			ro = append(ro, option{r.ID, service(r.Provider) + " · " + r.ID})
		}
		updateList(requests, ro, false)
		goOpts := make([]option, 0, len(s.Web.Connections))
		for _, c := range s.Web.Connections {
			goOpts = append(goOpts, option{c.ID, s.connectionLabel(c)})
		}
		updateList(grants, goOpts, false)
		page, _ := chosen(pages)
		switch page.key {
		case "home":
			renderAccountHome(projectOptions)
		case "services":
			renderServices()
		case "account":
			put(accountMessage, "앱을 잠그거나 로그아웃하면 이 기기의 AI 읽기 연결이 종료됩니다.")
			if purging {
				rows = append(rows, ids(purgeMessage, purgePassword, totpLabel, totpInput, purgeConfirm, cancelPurge)...)
			} else {
				rows = append(rows, ids(accountMessage, accountLock, accountLogout, startPurge)...)
			}
		case "connect":
			put(routeLabel, routeText(s.Web))
			rows = append(rows, ids(routeLabel)...)
			if s.Web.State == "ready" || s.Web.State == "starting" {
				rows = append(rows, ids(routeStop)...)
			} else {
				rows = append(rows, ids(routeStart)...)
			}
			if s.Web.State == "starting" && validSignIn(s.Web.SignInURL) {
				rows = append(rows, ids(signIn)...)
			}
			if s.Web.State == "ready" && s.Web.URL != "" {
				put(endpoint, s.Web.URL)
				rows = append(rows, ids(endpoint, copyURL, chat, claude)...)
			}
			rows = append(rows, ids(reconnectHelp, chatHelp, claudeHelp)...)
		case "memories":
			rows = append(rows, ids(newProjectLabel, newProject, createProject, scopeLabel, scope, keyLabel, key, valueLabel, value, save)...)
		case "permissions":
			text := "대기 중인 연결 요청이 없습니다. 서비스에서 연결을 시작하면 여기에 표시됩니다."
			if len(ro) > 0 {
				text = "연결 요청을 선택한 뒤 브라우저의 요청 번호 및 서비스 주소와 대조하세요."
			}
			put(requestLabel, text)
			rows = append(rows, ids(requestLabel)...)
			if len(ro) > 0 {
				rows = append(rows, ids(requests)...)
				if r, ok := activeRequest(); ok {
					put(requestDetails, requestInfo(r))
					rows = append(rows, ids(requestDetails, approvalScopeLabel, approvalScope, allow, deny)...)
				}
			}
			if len(goOpts) == 0 {
				put(grantLabel, "현재 승인한 연결이 없습니다.")
				rows = append(rows, ids(grantLabel)...)
			} else {
				put(grantLabel, "승인한 연결")
				rows = append(rows, ids(grantLabel, grants, revoke)...)
			}
		case "backup":
			rows = append(rows, ids(backupHint, exportBackup, recoveryHint, recoveryPassword, issueRecovery)...)
		case "capture":
			rows = append(rows, ids(captureLabel, capture)...)
		}
	}
	actionPending := busy && pending["op"] != "status" && pending["op"] != "previewContext"
	for _, row := range rows {
		usable(row.id, !actionPending)
	}
	if r, ok := activeRequest(); ok {
		usable(allow, !actionPending && (r.Provider == "chatgpt" || r.Provider == "claude"))
	}
	if !legacyMode && !s.Unlocked && !s.Account.Configured {
		for _, id := range []int{accountEmail, accountPassword, accountCode, accountSubmit, accountTrust, accountRegister, accountVerify, accountReset} {
			usable(id, false)
		}
	}
	_, hasGrant := chosen(grants)
	usable(revoke, !actionPending && hasGrant)
	moveControls()
}
func activeRequest() (request, bool) {
	item, ok := chosen(requests)
	if ok {
		for _, r := range s.Web.Requests {
			if r.ID == item.key {
				return r, true
			}
		}
	}
	return request{}, false
}
func requestInfo(r request) string {
	return service(r.Provider) + "\r\n요청 번호 " + r.ID + "\r\n콜백 " + r.RedirectURI + "\r\n만료 " + r.ExpiresAt
}
func dispatch(q command) {
	if offline || controller == nil || !sessionAvailable() || (inModal && actionGeneration != uiGeneration) {
		return
	}
	if q["op"] == "lock" || q["op"] == "accountLogout" || q["op"] == "accountPurge" {
		suppressResume = true
		if err := rememberLock(true); err != nil {
			notice = "기기 로그인 상태를 기록하지 못했습니다. 로그아웃 결과를 확인하세요."
		}
	}
	if busy {
		if (pending["op"] == "status" || pending["op"] == "previewContext") && q["op"] != "status" && queued == nil {
			queued = q
		}
		return
	}
	busy = true
	pending = q
	if q["op"] != "status" && q["op"] != "previewContext" {
		notice = "처리하고 있습니다."
		render(false)
	}
	c, gen := controller, uiGeneration
	go func() { r := c.execute(q); responses <- desktopReply{r, gen}; post.Call(mainWindow, 0x8001, 0, 0) }()
}
func finish(r reply) {
	q := pending
	pending = nil
	busy = false
	op, _ := q["op"].(string)
	// Forget password references as soon as the response arrives.
	delete(q, "password")
	delete(q, "code")
	delete(q, "totpCode")
	if !r.OK {
		queued = nil
		if r.Error == "ACCOUNT_MFA_REQUIRED" || r.Error == "ACCOUNT_MFA_INVALID" {
			loginMFA = true
		}
		if op == "accountLogin" && r.Error == "ACCOUNT_RECOVERY_REQUIRED" {
			freshEmail, _ = q["email"].(string)
			form = "recoverAccount"
		}
		if op == "accountLogin" && (r.Error == "SYNC_REMOTE_MISSING" || r.Error == "SYNC_EPOCH_CHANGED") {
			freshEmail, _ = q["email"].(string)
			form = "fresh"
		}
		if r.Error == "EXPLICIT_SUPERSESSION_REQUIRED" && op == "addPreference" && r.Previous != nil {
			actionGeneration = uiGeneration
			inModal = true
			ok := confirm("이 기억을 교체할까요?", "기존: "+r.Previous.Key+" = "+r.Previous.Value+"\n변경: "+q["value"].(string)+"\n기존 값은 이력에 남고 새 값이 적용됩니다.")
			inModal = false
			if ok {
				q["supersedesId"] = r.Previous.ID
				dispatch(q)
				return
			}
			notice = "교체를 취소했습니다."
		} else {
			notice = explain(r.Error)
		}
		if r.Error == "DEVICE_UNAVAILABLE" {
			offline = true
			clearPrivate()
		}
		if op == "previewContext" {
			put(previewText, "기억을 읽지 못했습니다. 동기화 상태를 확인하세요.")
		}
		if op == "accountResume" {
			notice = explain(r.Error)
		}
		if op == "status" && !offline {
			known = false
			clearPrivate()
		}
		render(false)
		if op != "status" && !offline {
			dispatch(command{"op": "status"})
		}
		return
	}
	prior := s
	s = r.Result
	if r.OK {
		acceptAccountReply(op, q, r, prior)
	}
	wasKnown := known
	known = true
	if !s.Unlocked && prior.Unlocked {
		clearPrivate()
		selectIndex(pages, 0)
	}
	if op != "status" {
		switch op {
		case "accountSignup", "accountVerify", "accountLogin", "accountSync", "accountPurge", "accountPurgeUnrecoverable", "accountLogout", "accountRequestReset", "accountReset", "previewContext":
			// The account screens set the next step in acceptAccountReply.
		case "restore", "recover":
			notice = "복원했습니다. 금고 비밀번호를 입력해 여세요."
			selectedBackup = ""
			selectedRecovery = ""
		case "backup":
			notice = "암호화 백업을 저장했습니다."
		case "issueRecovery":
			notice = "복구 파일을 발급했습니다. 지금 새 암호화 백업을 저장하고 두 파일을 따로 보관하세요."
		case "create", "unlock":
			notice = ""
		case "addPreference":
			notice = "승인한 기억을 저장했습니다."
			put(value, "")
			selectIndex(key, 0)
		case "addProject":
			notice = "프로젝트를 만들었습니다."
			put(newProject, "")
		case "approve":
			notice = "읽기를 승인했습니다. 서비스 화면으로 돌아가 인증을 마치세요."
		case "deny":
			notice = "요청을 거절했습니다."
		case "revoke":
			notice = "연결을 철회했습니다."
		default:
			notice = ""
		}
	}
	if op != "status" || !wasKnown || !reflect.DeepEqual(prior, s) {
		render(prior.Unlocked != s.Unlocked)
	}
	if queued != nil {
		next := queued
		queued = nil
		dispatch(next)
	} else {
		schedulePreview()
	}
}
func clearPrivate() {
	clearAccountPrivate()
	for _, id := range []int{password, repeat, newProject, key, value, requestDetails, endpoint, recoveryPassword, backupSelected, recoverySelected} {
		put(id, "")
	}
	for _, id := range []int{requests, grants, scope, approvalScope} {
		updateList(id, nil, false)
	}
}
func handleAction(id, notification int) {
	if isCombo(id) {
		if notification == 1 {
			if id == pages || id == initialMode {
				purging = false
				put(purgePassword, "")
				put(totpInput, "")
				put(password, "")
				put(repeat, "")
				put(recoveryPassword, "")
			}
			if id == requests {
				selectIndex(approvalScope, 0)
			}
			if id == previewScope {
				forgetPreview()
			}
			render(id == pages)
			schedulePreview()
		}
		return
	}
	if notification != 0 || offline || inModal || !sessionAvailable() {
		return
	}
	actionGeneration = uiGeneration
	inModal = true
	defer func() { inModal = false }()
	if accountAction(id) {
		return
	}
	switch id {
	case openVault:
		openFromForm()
	case chooseBackup:
		if p := chooseFile("복원할 암호화 백업 선택", false, false); p != "" {
			selectedBackup = p
			render(false)
		}
	case chooseRecovery:
		if p := chooseFile("백업과 짝이 맞는 복구 파일 선택", true, false); p != "" {
			selectedRecovery = p
			render(false)
		}
	case exportBackup:
		if p := chooseFile("새 암호화 백업 저장", false, true); p != "" {
			dispatch(command{"op": "backup", "file": p})
		}
	case issueRecovery:
		issueRecoveryFile()
	case lock:
		dispatch(command{"op": "lock"})
	case createProject:
		dispatch(command{"op": "addProject", "name": strings.TrimSpace(textValue(newProject))})
	case save:
		sc, ok := chosen(scope)
		if !ok {
			return
		}
		title, v := strings.TrimSpace(textValue(key)), strings.TrimSpace(textValue(value))
		k := title
		for _, o := range listData[key] {
			if title == o.label {
				k = o.key
				break
			}
		}
		if !validKey.MatchString(k) {
			notice = "목록의 항목을 선택하거나 영문 소문자로 시작하는 항목 ID를 입력하세요."
			render(false)
			return
		}
		if k == "" || v == "" {
			notice = "항목 이름과 내용을 입력하세요."
			render(false)
			return
		}
		if confirm("이 기억을 저장할까요?", sc.label+"\n"+title+" = "+v+"\n이 범위의 읽기를 승인하면 AI 서비스가 이 내용을 읽을 수 있습니다.") {
			dispatch(command{"op": "addPreference", "projectId": nullable(sc.key), "key": k, "value": v})
		}
	case routeStart:
		dispatch(command{"op": "startWeb"})
	case routeStop:
		dispatch(command{"op": "stopWeb"})
	case signIn:
		if validSignIn(s.Web.SignInURL) {
			openService(s.Web.SignInURL)
		}
	case copyURL:
		if s.Web.State == "ready" && s.Web.URL != "" {
			send.Call(controls[endpoint], 0xb1, 0, ^uintptr(0))
			send.Call(controls[endpoint], 0x301, 0, 0)
			notice = "선택한 주소를 서비스의 MCP 서버 URL 칸에 붙여넣으세요."
			render(false)
		}
	case chat:
		openService("https://chatgpt.com/plugins")
	case claude:
		openService("https://claude.ai/customize/connectors")
	case reconnectHelp:
		messageBox("Growth Brain 다시 연결하기", "1. 금고를 열고 ‘공개 연결 시작’을 누르세요. 주소가 표시된 뒤 ‘서비스에 등록할 주소 복사’를 누르세요.\n\n2. 이 화면에서 ChatGPT 또는 Claude 설정을 열고 Growth Brain 연결을 다시 인증하세요. 서비스가 앱을 찾지 못하거나 ‘invalid_client’를 표시하면, 서비스 설정에서 기존 Growth Brain 등록만 제거한 뒤 복사한 주소로 OAuth 앱·커넥터를 다시 추가하세요. 조직에서 관리하는 항목은 관리자에게 재등록을 요청하세요.\n\n3. 브라우저 요청 번호와 앱의 ‘연결 승인·철회’ 번호를 확인하고 읽기 범위를 승인하세요. 서비스 화면으로 돌아가 연결을 마치세요.", 0x40)
	case chatHelp:
		openService("https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt")
	case claudeHelp:
		openService("https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp")
	case allow:
		r, ok := activeRequest()
		sc, hasScope := chosen(approvalScope)
		if !ok || !hasScope || !(r.Provider == "chatgpt" || r.Provider == "claude") {
			return
		}
		if confirm("이 서비스에 읽기를 허용할까요?", requestInfo(r)+"\n허용 범위: "+sc.label+"\n전달된 기억은 AI 서비스가 읽을 수 있습니다. 이 요청 번호와 콜백 주소가 브라우저와 일치합니까?") {
			dispatch(command{"op": "approve", "requestId": r.ID, "projectId": nullable(sc.key)})
		}
	case deny:
		if r, ok := activeRequest(); ok {
			dispatch(command{"op": "deny", "requestId": r.ID})
		}
	case revoke:
		if g, ok := chosen(grants); ok && confirm("이 연결을 철회할까요?", g.label+"\n이 연결의 다음 읽기 요청부터 차단됩니다.") {
			dispatch(command{"op": "revoke", "connectionId": g.key})
		}
	case capture:
		prepareCapture()
	}
}
func openService(target string) {
	if !openKnown(target) {
		notice = "브라우저를 열 수 없습니다. 기본 브라우저를 확인하세요."
		render(false)
	}
}
func nullable(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
func prepareCapture() {
	if !confirm("Chrome 기기 연결을 등록할까요?", "현재 Windows 사용자의 Chrome에 Growth Brain을 등록합니다. 사이트의 수집 권한은 확장 팝업에서 직접 선택하세요.") {
		return
	}
	path, e := os.Executable()
	if e != nil {
		return
	}
	root := filepath.Dir(path)
	cmd := exec.Command(filepath.Join(root, "NativeHost.exe"), "--register")
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := cmd.Run(); err != nil {
		notice = "등록을 완료하지 못했습니다. 기존 등록과의 충돌 또는 관리 정책을 확인하세요."
	} else {
		notice = "Chrome 확장 관리에서 방금 연 폴더를 선택하세요."
		if !openKnown(filepath.Join(root, "extension")) {
			notice = "확장 폴더를 열지 못했습니다. 앱을 다시 실행하세요."
		}
	}
	render(false)
}
func main() {
	file, suppressed, err := acquireDesktop()
	if err != nil {
		if errors.Is(err, alreadyRunning) {
			cls := wide("GrowthBrainVaultDesktop")
			h, _, _ := user.NewProc("FindWindowW").Call(ptr(cls), 0)
			if h != 0 {
				user.NewProc("ShowWindowAsync").Call(h, 9)
				user.NewProc("SetForegroundWindow").Call(h)
				return
			}
			messageBox("Growth Brain", "현재 Windows 사용자의 다른 세션에서 Growth Brain을 사용 중입니다. 해당 창을 닫고 다시 실행하세요.", 0x40)
		} else {
			messageBox("Growth Brain", "이 Windows 프로필에서 앱을 안전하게 시작할 수 없습니다. 프로필 저장소를 확인하세요.", 0x10)
		}
		return
	}
	ownerFile = file
	suppressResume = suppressed
	defer file.Close()
	runApp()
}
