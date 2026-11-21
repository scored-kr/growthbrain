package main

import "strings"

const (
	accountEmailLabel = 200 + iota
	accountEmail
	accountPasswordLabel
	accountPassword
	accountCodeLabel
	accountCode
	accountTrust
	accountSubmit
	accountRegister
	accountVerify
	accountReset
	accountOptions
	returnToSignIn
	accountMessage
	accountLogout
	accountLock
	refreshAccount
	previewScope
	previewText
	chooseChat
	chooseClaude
	chooseAgain
	startPurge
	purgeMessage
	purgePassword
	purgeConfirm
	cancelPurge
	totpLabel
	totpInput
	eraseUnrecoverable
	eraseTypedLabel
	eraseTyped
)

var legacyPages = []option{{"connect", "서비스 연결"}, {"permissions", "연결 승인·철회"}, {"memories", "기억과 프로젝트"}, {"capture", "대화 수집 (선택)"}, {"backup", "백업·복구 파일"}}
var accountPages = []option{{"home", "내 선호도와 프로젝트"}, {"memories", "프로젝트와 기억 편집"}, {"services", "ChatGPT·Claude 연결"}, {"permissions", "연결 승인·철회"}, {"capture", "대화 수집 (선택)"}, {"account", "계정"}}

var legacyMode, purging, loginMFA bool
var form = "login"
var selectedService, freshEmail string
var previewFor string

func createAccountControls() {
	label := func(id int, t string) { newControl(id, "STATIC", t, 0x80, 0) }
	button := func(id int, t string) { newControl(id, "BUTTON", t, 0x10000, 0) }
	edit := func(id int, flags uintptr) { newControl(id, "EDIT", "", 0x10000|flags, 0x200) }
	label(accountEmailLabel, "이메일")
	edit(accountEmail, 0x80)
	label(accountPasswordLabel, "Growth Brain 비밀번호")
	edit(accountPassword, 0x80|0x20)
	label(accountCodeLabel, "이메일로 받은 확인 코드")
	edit(accountCode, 0x80|0x20)
	send.Call(controls[accountEmail], 0xc5, 254, 0)
	send.Call(controls[accountPassword], 0xc5, 1024, 0)
	send.Call(controls[accountCode], 0xc5, 32, 0)
	newControl(accountTrust, "BUTTON", "이 개인 PC를 신뢰하고 다음에 자동 로그인", 0x10000|3, 0)
	button(accountSubmit, "로그인")
	button(accountRegister, "계정 만들기")
	button(accountVerify, "받은 확인 코드 입력")
	button(accountReset, "비밀번호 찾기")
	button(accountOptions, "기존 로컬 데이터 사용 (선택)")
	button(returnToSignIn, "계정 로그인으로")
	label(accountMessage, "")
	button(accountLogout, "로그아웃")
	button(accountLock, "지금 잠그기")
	button(refreshAccount, "동기화 다시 확인")
	newControl(previewScope, "COMBOBOX", "", 0x10000|0x00200000|3, 0)
	edit(previewText, 0x800|4|0x200000|0x40)
	button(chooseChat, "ChatGPT 연결")
	button(chooseClaude, "Claude 연결")
	button(chooseAgain, "다른 서비스 선택")
	button(startPurge, "계정 기억 전체 삭제…")
	label(purgeMessage, "이 계정의 서버 기억과 이 기기의 계정 기억이 삭제됩니다. 기존 백업 및 AI 서비스에 이미 전달된 내용은 남습니다. Growth Brain 계정은 유지됩니다. 계속하려면 계정 비밀번호를 다시 입력하세요.")
	edit(purgePassword, 0x80|0x20)
	send.Call(controls[purgePassword], 0xc5, 1024, 0)
	button(purgeConfirm, "계정 기억 삭제 확인")
	button(cancelPurge, "취소")
	label(totpLabel, "인증 앱 코드 (2단계 인증 사용 시, 6자리)")
	edit(totpInput, 0x80|0x20)
	send.Call(controls[totpInput], 0xc5, 6, 0)
	button(eraseUnrecoverable, "복구할 수 없는 계정 기억 삭제…")
	label(eraseTypedLabel, "계속하려면 ‘복구 불가 기억 삭제’를 입력하세요.")
	edit(eraseTyped, 0x80)
}
func renderSignIn() {
	title, submit := "Growth Brain 로그인", "로그인"
	switch form {
	case "signup":
		title, submit = "Growth Brain 계정 만들기", "확인 메일 받기"
	case "erase":
		title, submit = "복구할 수 없는 계정 기억 삭제", "삭제 확인"
	case "recoverAccount":
		put(banner, "기존 기억을 복호화할 수 없습니다.")
		put(accountMessage, "이전 비밀번호나 가능한 복구 방법을 먼저 확인하세요. 기존 기억을 보존하려면 로그인으로 돌아가세요.")
		rows = append(rows, ids(accountMessage, returnToSignIn, eraseUnrecoverable)...)
		return
	case "fresh":
		title, submit = "삭제된 계정 기억 확인", "현재 계정 상태로 다시 시작"
	case "verify":
		title, submit = "가입 이메일 확인", "확인 코드 제출"
	case "reset":
		title, submit = "Growth Brain 비밀번호 찾기", "재설정 메일 받기"
	case "resetCode":
		title, submit = "비밀번호 재설정", "새 비밀번호 저장"
	}
	put(banner, title)
	put(accountSubmit, submit)
	if !s.Account.Configured {
		put(accountMessage, explain("AUTH_UNCONFIGURED"))
		rows = append(rows, ids(accountMessage)...)
	}
	rows = append(rows, ids(accountEmailLabel, accountEmail)...)
	if form == "verify" || form == "resetCode" {
		rows = append(rows, ids(accountCodeLabel, accountCode)...)
	}
	if form == "login" || form == "erase" || form == "fresh" || form == "signup" || form == "resetCode" {
		label := "Growth Brain 비밀번호"
		if form == "signup" || form == "resetCode" {
			label = "새 비밀번호 (16자 이상, 서로 다른 문자 6개 이상)"
		}
		put(accountPasswordLabel, label)
		rows = append(rows, ids(accountPasswordLabel, accountPassword)...)
	}
	if (loginMFA && (form == "login" || form == "fresh")) || form == "resetCode" || form == "erase" {
		rows = append(rows, ids(totpLabel, totpInput)...)
	}
	if form == "erase" {
		put(accountMessage, "이 계정의 복호화할 수 없는 프로젝트와 기억 전체를 서버에서 삭제하고 새로 시작합니다. 삭제한 기억은 되돌릴 수 없습니다.")
		rows = append(rows, ids(accountMessage, eraseTypedLabel, eraseTyped)...)
	}
	if form == "login" {
		rows = append(rows, ids(accountTrust)...)
	}
	if form == "fresh" {
		put(accountMessage, "이 PC의 이전 기억은 업로드되지 않습니다. 서버의 새 계정 기억을 사용하거나 비어 있는 상태에서 시작하려면 같은 계정 비밀번호를 다시 입력하세요.")
		rows = append(rows, ids(accountMessage)...)
	}
	if form == "resetCode" && s.Account.Configured {
		put(accountMessage, "비밀번호를 재설정해도 기존에 암호화한 기억은 복구되지 않을 수 있습니다.")
		rows = append(rows, ids(accountMessage)...)
	}
	rows = append(rows, ids(accountSubmit)...)
	if form == "login" {
		rows = append(rows, ids(accountRegister, accountVerify, accountReset, accountOptions)...)
	} else {
		rows = append(rows, ids(returnToSignIn)...)
	}
}
func switchForm(to string) {
	form = to
	freshEmail = ""
	loginMFA = false
	put(totpInput, "")
	put(eraseTyped, "")
	notice = ""
	put(accountPassword, "")
	put(accountCode, "")
	send.Call(controls[accountTrust], 0xf1, 0, 0)
	render(true)
}
func renderAccountHome(options []option) {
	updateList(previewScope, options, true)
	rows = append(rows, ids(previewScope, previewText, refreshAccount)...)
}
func forgetPreview() {
	previewFor = ""
	put(previewText, "승인된 기억을 확인하고 있습니다.")
}
func schedulePreview() {
	if !known || offline || busy || !s.Unlocked || !s.Account.SignedIn || s.Account.Review {
		return
	}
	p, _ := chosen(pages)
	sc, ok := chosen(previewScope)
	if p.key == "home" && ok && previewFor != s.Account.Email+"/"+sc.key {
		previewFor = s.Account.Email + "/" + sc.key
		dispatch(command{"op": "previewContext", "projectId": nullable(sc.key)})
	}
}
func clearAccountPrivate() {
	freshEmail = ""
	loginMFA = false
	put(totpInput, "")
	put(eraseTyped, "")
	purging = false
	put(purgePassword, "")
	put(accountEmail, "")
	put(accountPassword, "")
	put(accountCode, "")
	put(previewText, "")
	send.Call(controls[accountTrust], 0xf1, 0, 0)
	updateList(previewScope, nil, false)
	previewFor = ""
	selectedService = ""
}
func acceptAccountReply(op string, q command, r reply, prior state) {
	if s.Account.SignedIn && !prior.Account.SignedIn {
		if op == "accountLogin" {
			if err := rememberLock(false); err == nil {
				suppressResume = false
			} else {
				suppressResume = true
			}
		}
		legacyMode = false
		form = "login"
		selectedService = ""
		put(accountPassword, "")
		put(accountCode, "")
		updateList(pages, accountPages, true)
		selectIndex(pages, 0)
		forgetPreview()
	}
	if op == "accountSync" || op == "addProject" || op == "addPreference" || (s.Account.SignedIn && prior.Account.Version != s.Account.Version) {
		forgetPreview()
	}
	switch op {
	case "accountSignup":
		form = "verify"
		notice = "이메일을 확인하고 가입 확인 코드를 입력하세요."
	case "accountVerify":
		form = "login"
		notice = "이메일을 확인했습니다. 계정으로 로그인하세요."
	case "accountRequestReset":
		form = "resetCode"
		notice = "메일을 받았다면 확인 코드와 새 비밀번호를 입력하세요."
	case "accountReset":
		form = "login"
		notice = "새 비밀번호로 로그인하세요."
	case "accountPurgeUnrecoverable":
		notice = "기존 계정 기억을 삭제하고 새로 시작했습니다."
	case "accountLogin", "accountSync", "accountResume":
		notice = ""
	case "accountPurge":
		form = "login"
		legacyMode = false
		notice = "이 계정의 기억을 삭제하고 로그아웃했습니다."
	case "accountLogout":
		form = "login"
		legacyMode = false
		notice = "로그아웃했습니다."
	case "previewContext":
		sc, ok := chosen(previewScope)
		p, _ := chosen(pages)
		if s.Account.SignedIn && ok && p.key == "home" && nullable(sc.key) == q["projectId"] && r.Preview != nil {
			put(previewText, r.Preview.text())
		}
	}
}
func accountAction(id int) bool {
	switch id {
	case accountOptions:
		legacyMode = true
		switchForm("login")
	case returnToSignIn:
		legacyMode = false
		switchForm("login")
	case accountRegister:
		switchForm("signup")
	case accountVerify:
		switchForm("verify")
	case accountReset:
		switchForm("reset")
	case accountSubmit:
		if !s.Account.Configured {
			return true
		}
		email := strings.TrimSpace(textValue(accountEmail))
		if email == "" {
			notice = "로그인할 이메일을 입력하세요."
			render(false)
			return true
		}
		q := command{"email": email}
		attachTOTP(q)
		if form == "login" || form == "erase" || form == "fresh" || form == "signup" || form == "resetCode" {
			pass := textValue(accountPassword)
			if (form == "signup" || form == "resetCode") && !meetsAccountLength(pass) {
				notice = explain("WEAK_ACCOUNT_PASSWORD")
				render(false)
				return true
			}
			if pass == "" {
				notice = "Growth Brain 비밀번호를 입력하세요."
				render(false)
				return true
			}
			q["password"] = pass
			put(accountPassword, "")
		}
		if form == "verify" || form == "resetCode" {
			q["code"] = strings.TrimSpace(textValue(accountCode))
			put(accountCode, "")
		}
		switch form {
		case "login":
			trust, _, _ := send.Call(controls[accountTrust], 0xf0, 0, 0)
			q["op"] = "accountLogin"
			q["trustDevice"] = trust == 1
		case "erase":
			if freshEmail == "" || !strings.EqualFold(freshEmail, email) || strings.TrimSpace(textValue(eraseTyped)) != "복구 불가 기억 삭제" {
				notice = "확인한 계정 이메일과 삭제 확인 문구를 입력하세요."
				render(false)
				return true
			}
			if !confirm("되돌릴 수 없는 계정 기억 삭제", email+" 계정에서 복호화되지 않는 모든 기억을 영구 삭제하고 빈 상태로 시작할까요?") {
				return true
			}
			q["op"] = "accountPurgeUnrecoverable"
			q["confirmation"] = "ERASE UNRECOVERABLE MEMORY"
			put(eraseTyped, "")
		case "fresh":
			if freshEmail == "" || !strings.EqualFold(email, freshEmail) {
				notice = "삭제 상태를 확인했던 같은 계정으로 다시 로그인하세요."
				render(false)
				return true
			}
			if !confirm("이 계정의 새 기억을 사용할까요?", email+"의 삭제 전 기록은 서버로 보내지 않습니다. 현재 서버의 기억 또는 새 빈 저장소로 시작합니다.") {
				return true
			}
			q["op"] = "accountLogin"
			q["startFresh"] = true
		case "signup":
			q["op"] = "accountSignup"
		case "verify":
			q["op"] = "accountVerify"
		case "reset":
			q["op"] = "accountRequestReset"
		case "resetCode":
			q["op"] = "accountReset"
		default:
			return true
		}
		dispatch(q)
	case eraseUnrecoverable:
		if freshEmail != "" && form == "recoverAccount" {
			form = "erase"
			notice = ""
			put(accountEmail, freshEmail)
			put(accountPassword, "")
			put(totpInput, "")
			put(eraseTyped, "")
			render(true)
		}
	case startPurge:
		purging = true
		put(purgePassword, "")
		render(true)
	case cancelPurge:
		purging = false
		put(purgePassword, "")
		render(true)
	case purgeConfirm:
		if !purging || !s.Account.SignedIn {
			return true
		}
		pass := textValue(purgePassword)
		put(purgePassword, "")
		if pass == "" {
			notice = "삭제를 승인하려면 현재 계정 비밀번호를 입력하세요."
			render(false)
			return true
		}
		if confirm("계정의 모든 기억을 삭제할까요?", s.Account.Email+" 계정의 프로젝트·선호도·기억 전체를 서버와 이 기기에서 삭제하고 로그아웃합니다. 이 작업을 되돌릴 수 없습니다.") {
			q := command{"op": "accountPurge", "password": pass, "confirmation": "DELETE ACCOUNT MEMORY"}
			attachTOTP(q)
			dispatch(q)
		}
	case accountLogout:
		dispatch(command{"op": "accountLogout"})
	case accountLock:
		dispatch(command{"op": "lock"})
	case refreshAccount:
		dispatch(command{"op": "accountSync"})
	case chooseChat, chooseClaude:
		if id == chooseChat {
			selectedService = "chatgpt"
		} else {
			selectedService = "claude"
		}
		if s.Web.State == "off" || s.Web.State == "unavailable" {
			dispatch(command{"op": "startWeb"})
		} else {
			render(false)
		}
	case chooseAgain:
		selectedService = ""
		render(false)
	default:
		return false
	}
	return true
}
func renderServices() {
	if selectedService == "" {
		put(routeLabel, "읽기 연결을 만들 서비스를 선택하세요. 선택한 서비스에서 승인한 범위의 기억을 읽을 수 있습니다.")
		rows = append(rows, ids(routeLabel, chooseChat, chooseClaude)...)
		return
	}
	rows = append(rows, ids(chooseAgain)...)
	help, settings := chatHelp, chat
	if selectedService == "claude" {
		help, settings = claudeHelp, claude
	}
	text := "선택한 서비스의 읽기 연결을 준비하고 있습니다."
	if s.Web.State == "unavailable" {
		text = explain(s.Web.Error)
	}
	if s.Web.State == "off" {
		text = "기기에서 읽기 연결을 다시 준비하세요."
	}
	if s.Web.State == "ready" {
		if selectedService == "claude" {
			text = "Claude 커넥터 설정에서 사용자 정의 커넥터에 아래 주소를 추가하세요. OAuth 인증을 시작한 뒤 앱의 ‘연결 승인·철회’에서 요청 번호와 제공 범위를 확인하세요."
		} else {
			text = "ChatGPT 플러그인 설정에서 사용자 정의 MCP 서버에 아래 주소를 추가하세요. OAuth 인증을 시작한 뒤 앱의 ‘연결 승인·철회’에서 요청 번호와 제공 범위를 확인하세요."
		}
	}
	put(routeLabel, text)
	rows = append(rows, ids(routeLabel)...)
	switch s.Web.State {
	case "ready":
		put(endpoint, s.Web.URL)
		rows = append(rows, ids(endpoint, copyURL, settings, routeStop)...)
	case "starting":

		rows = append(rows, ids(routeStop)...)
	default:
		rows = append(rows, ids(routeStart)...)
	}
	rows = append(rows, ids(help)...)
}

func attachTOTP(q command) {
	code := strings.TrimSpace(textValue(totpInput))
	put(totpInput, "")
	if code != "" {
		q["totpCode"] = code
	}
}
