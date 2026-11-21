// The desktop owns a private, sequential JSON stream to its child. No HTTP
// route, command line, clipboard or environment variable carries a password.
package main

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

type project struct{ ID, Name string }
type request struct{ ID, ClientName, RedirectURI, Provider, ExpiresAt string }
type connection struct {
	ID, ClientName, ProjectID, RedirectURI, Provider, ExpiresAt string
	Connected                                                   bool
}
type auditEntry struct {
	At, Method, ConnectionID string
	Success                  bool
}
type webState struct {
	State, URL, SignInURL, Error string
	Requests                     []request
	Connections                  []connection
	Audit                        []auditEntry
}
type state struct {
	Exists, Unlocked bool
	Projects         []project
	Web              webState
}
type reply struct {
	ID       int
	OK       bool
	Result   state
	Error    string
	Previous *struct{ ID, Key, Value string }
}

var validKey = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,79}$`)
var signInPath = regexp.MustCompile("^/a/[A-Za-z0-9_-]+$")
var funnelQuery = regexp.MustCompile("^node=[A-Za-z0-9_-]+$")

func validSignIn(s string) bool {
	u, e := url.Parse(s)
	if e != nil || u.Scheme != "https" || u.Host != "login.tailscale.com" || u.User != nil || u.ForceQuery || u.Fragment != "" {
		return false
	}
	return (signInPath.MatchString(u.EscapedPath()) && u.RawQuery == "") ||
		(u.EscapedPath() == "/f/funnel" && funnelQuery.MatchString(u.RawQuery))
}

func service(provider string) string {
	switch provider {
	case "chatgpt":
		return "ChatGPT"
	case "claude":
		return "Claude"
	default:
		return "지원하지 않는 서비스"
	}
}
func (s state) scope(id string) string {
	if id == "" {
		return "공통 기억만"
	}
	for _, p := range s.Projects {
		if p.ID == id {
			return "공통 + " + p.Name
		}
	}
	return "선택한 프로젝트"
}
func (s state) connectionLabel(c connection) string {
	phase := "승인됨 · 서비스 인증 대기"
	if c.Connected {
		phase = "서비스 인증됨"
	}
	for _, e := range s.Web.Audit {
		if c.ID != "" && e.ConnectionID == c.ID && e.Method == "get_context" && e.Success {
			phase = "맥락 조회 확인"
			break
		}
	}
	return service(c.Provider) + " · " + s.scope(c.ProjectID) + " · " + phase
}

func explain(code string) string {
	switch code {
	case "RESTORE_TARGET_EXISTS":
		return "이 Windows 프로필에 금고 저장 폴더가 이미 있습니다. 기존 금고를 보존하고 금고가 없는 다른 Windows 프로필에서 복원하세요."
	case "BACKUP_DESTINATION_EXISTS":
		return "이미 있는 파일입니다. 새 파일 이름을 선택하세요."
	case "INVALID_RECOVERY_FILE", "RECOVERY_FILE_REQUIRED", "RESTORE_INPUT_INVALID":
		return "선택한 백업·복구 파일과 비밀번호가 서로 맞는지 확인하세요."
	case "RECOVERY_NOT_ENABLED":
		return "이 백업에는 복구 파일이 설정되어 있지 않습니다. 원래 비밀번호로 복원하거나 복구 파일 발급 후 만든 백업을 선택하세요."
	case "WINDOWS_PRIVATE_STORAGE_REQUIRED", "PRIVATE_FILE_UNAVAILABLE", "KEEP_RECOVERY_SEPARATE", "RECOVERY_IN_REPOSITORY":
		return "Windows 사용자 프로필 안의 개인 폴더를 선택하세요. 복구 파일은 금고와 백업에서 분리해 보관하세요."
	case "UNLOCK_FAILED", "AUTHENTICATION_FAILED":
		return "금고를 열지 못했습니다. 비밀번호를 확인하세요."
	case "PASSPHRASE_LENGTH":
		return "비밀번호를 12자 이상 입력하세요."
	case "VAULT_EXISTS":
		return "기존 금고가 있습니다. 잠금 해제를 선택하세요."
	case "VAULT_ALREADY_OPEN_OR_STALE_LOCK":
		return "다른 창에서 금고를 사용 중이거나 이전 실행이 정상 종료되지 않았습니다. 다른 창을 닫고 다시 시도하세요."
	case "ROUTE_POLICY_BLOCKED":
		return "Tailscale 계정의 HTTPS 또는 Funnel 정책이 연결을 허용하지 않습니다. 계정 관리자에게 승인을 요청하세요."
	case "ROUTE_UNAVAILABLE", "ROUTE_NOT_CONFIGURED":
		return "공개 연결 경로를 준비하지 못했습니다. 계정에서 Funnel을 사용할 수 있는지 확인한 후 다시 시도하세요."
	case "ROUTE_OFFLINE":
		return "네트워크 경로에 접속할 수 없습니다. 인터넷 연결을 확인한 후 다시 시도하세요."
	case "ROUTE_CERTIFICATE":
		return "기기 인증서를 준비하지 못했습니다. 계정에서 HTTPS 사용을 허용하는지 확인하세요."
	case "ROUTE_CANCELLED":
		return "공개 연결 준비가 중지되었습니다. 다시 시작할 수 있습니다."
	case "CONNECTION_REQUEST_NOT_FOUND":
		return "요청이 만료되었거나 처리되었습니다. 서비스에서 다시 연결하세요."
	case "UNSUPPORTED_PROVIDER", "UNSUPPORTED_CALLBACK":
		return "서비스의 공식 콜백을 확인할 수 없습니다. 서비스의 앱 추가 화면에서 다시 시작하세요."
	case "VAULT_LOCKED":
		return "금고를 먼저 여세요."
	case "INVALID_INPUT":
		return "입력값을 확인한 뒤 다시 시도하세요."
	case "STALE_SUPERSESSION", "EXPLICIT_SUPERSESSION_REQUIRED":
		return "저장된 기억이 변경되었습니다. 입력과 교체 대상을 다시 확인하세요."
	case "PRIVATE_DIRECTORY_REQUIRED", "INVALID_VAULT_FILE", "UNSAFE_WINDOWS_PATH":
		return "금고 저장 위치의 사용자 권한이나 파일을 확인할 수 없습니다."
	case "DEVICE_UNAVAILABLE":
		return "기기 프로세스와의 연결이 종료되었습니다. 앱을 닫고 다시 여세요."
	default:
		if code != "" && len(code) < 64 && strings.IndexFunc(code, func(r rune) bool { return !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') }) == -1 {
			return "작업을 마치지 못했습니다. 다시 시도하세요. (" + code + ")"
		}
		return "작업을 마치지 못했습니다. 다시 시도하세요."
	}
}

type command map[string]interface{}

func decodeReply(line []byte, id int) (reply, bool) {
	var r reply
	err := json.Unmarshal(line, &r)
	return r, err == nil && r.ID == id && (r.OK || r.Error != "")
}
