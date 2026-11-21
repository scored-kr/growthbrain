package main

import (
	"fmt"
	"strings"
)

const (
	conflictExplain = 260 + iota
	inspectConflict
	conflictItems
	localCaption
	localVersion
	remoteCaption
	remoteVersion
	keepLocal
	keepRemote
	previousPage
	nextPage
	commitChoices
)

var review *conflictPage
var decisions []byte

func createConflictControls() {
	label := func(id int, text string) { newControl(id, "STATIC", text, 0x80, 0) }
	button := func(id int, text string) { newControl(id, "BUTTON", text, 0x10000, 0) }
	edit := func(id int) { newControl(id, "EDIT", "", 0x10000|0x800|4|0x200000|0x40, 0x200) }
	label(conflictExplain, "")
	button(inspectConflict, "양쪽 변경 비교")
	newControl(conflictItems, "COMBOBOX", "", 0x10000|0x00200000|3, 0)
	label(localCaption, "이 기기의 값")
	edit(localVersion)
	label(remoteCaption, "계정에 동기화된 값")
	edit(remoteVersion)
	button(keepLocal, "이 기기의 값 선택")
	button(keepRemote, "계정의 값 선택")
	button(previousPage, "이전 항목")
	button(nextPage, "다음 항목")
	button(commitChoices, "선택한 값으로 동기화")
}
func discardReview() {
	review = nil
	decisions = nil
	updateList(conflictItems, nil, false)
	put(localVersion, "")
	put(remoteVersion, "")
	put(conflictExplain, "")
}
func showReview(page *conflictPage) {
	if page == nil {
		discardReview()
		return
	}
	if page.Total <= 0 || page.Total > 10000 || page.Offset < 0 || page.Offset >= page.Total || len(page.Items) == 0 || len(page.Items) > 16 || len(page.Items) > page.Total-page.Offset {
		discardReview()
		notice = "비교 결과를 읽지 못했습니다. 다시 확인하세요."
		return
	}
	same := review != nil && review.Token == page.Token && len(decisions) == page.Total
	if !same {
		decisions = make([]byte, page.Total)
	}
	review = page
}

// Win32 edit controls use CRLF and cannot display an embedded NUL.
func conflictText(value string) string {
	value = strings.ReplaceAll(value, "\x00", "␀")
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.ReplaceAll(value, "\n", "\r\n")
}
func renderConflict() {
	put(banner, "변경 내용을 확인해야 합니다.")
	rows = append(rows, ids(conflictExplain)...)
	if review == nil {
		put(conflictExplain, "두 기기의 변경을 자동으로 합칠 수 없습니다. 확인할 때까지 AI 읽기가 중지됩니다.")
		rows = append(rows, ids(inspectConflict, refreshAccount, accountLock, accountLogout)...)
		return
	}
	selected := 0
	for _, c := range decisions {
		if c == 'L' || c == 'R' {
			selected++
		}
	}
	put(conflictExplain, fmt.Sprintf("%d / %d개 선택 · 항목마다 유지할 값을 고른 뒤 동기화하세요.", selected, review.Total))
	options := make([]option, 0, len(review.Items))
	for i, item := range review.Items {
		scope := "공통"
		if item.ProjectID != "" {
			scope = conflictText(item.ProjectName)
			if scope == "" {
				scope = "프로젝트 " + item.ProjectID
			}
		}
		choice := "미선택"
		switch decisions[review.Offset+i] {
		case 'L':
			choice = "이 기기"
		case 'R':
			choice = "계정"
		}
		options = append(options, option{item.ID, fmt.Sprintf("%d. %s · %s · %s", review.Offset+i+1, scope, item.Key, choice)})
	}
	updateList(conflictItems, options, true)
	if i := selection(conflictItems); i >= 0 && i < len(review.Items) {
		item := review.Items[i]
		put(localVersion, conflictText(item.LocalValue))
		put(remoteVersion, conflictText(item.RemoteValue))
	}
	rows = append(rows, ids(conflictItems, localCaption, localVersion, keepLocal, remoteCaption, remoteVersion, keepRemote)...)
	if review.Offset > 0 {
		rows = append(rows, ids(previousPage)...)
	}
	if review.Offset+len(review.Items) < review.Total {
		rows = append(rows, ids(nextPage)...)
	}
	if selected == review.Total {
		rows = append(rows, ids(commitChoices)...)
	}
	rows = append(rows, ids(inspectConflict, accountLock, accountLogout)...)
}
func conflictAction(id int) bool {
	if !s.Account.Review {
		return false
	}
	switch id {
	case inspectConflict:
		dispatch(command{"op": "reviewSyncConflicts"})
	case keepLocal, keepRemote:
		if review == nil {
			return true
		}
		i := selection(conflictItems)
		if i >= 0 && i < len(review.Items) {
			c := byte('L')
			if id == keepRemote {
				c = 'R'
			}
			decisions[review.Offset+i] = c
			render(false)
		}
	case previousPage, nextPage:
		if review != nil {
			offset := max(0, review.Offset-16)
			if id == nextPage {
				offset = review.Offset + len(review.Items)
			}
			if offset < review.Total {
				dispatch(command{"op": "reviewSyncConflicts", "offset": offset, "token": review.Token})
			}
		}
	case commitChoices:
		if review != nil && len(decisions) == review.Total && !strings.ContainsRune(string(decisions), 0) &&
			confirm("선택한 값으로 동기화할까요?", fmt.Sprintf("%d개 항목에 선택한 값을 적용합니다. 변경 내용이 바뀌면 양쪽 값을 다시 확인해야 합니다.", review.Total)) {
			dispatch(command{"op": "resolveSyncConflicts", "token": review.Token, "decisions": string(decisions)})
		}
	default:
		return false
	}
	return true
}
