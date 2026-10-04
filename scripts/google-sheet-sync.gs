/**
 * Findar → 지원 현황 Google 시트 동기화 (Apps Script 웹 앱)
 *
 * Findar(lib/sheet-sync.ts)가 지원 상태를 바꿀 때마다 이 웹 앱으로 POST를 보낸다.
 * 링크 열(F)의 KOFIA 공고 번호(seq=)로 기존 행을 찾아 단계·결과를 갱신하고, 없으면 새 행을 추가한다.
 *
 * 설치
 *  1. 지원 현황 시트에서 [확장 프로그램] → [Apps Script]를 열고 이 파일 내용을 그대로 붙여 넣는다.
 *  2. [프로젝트 설정] → [스크립트 속성]에 FINDAR_TOKEN = (임의의 긴 문자열)을 추가한다.
 *     Findar의 .env.local에도 같은 값을 FINDAR_SHEET_SYNC_TOKEN으로 넣는다.
 *  3. [배포] → [새 배포] → 유형 "웹 앱", 실행 사용자 "나", 액세스 권한 "모든 사용자"로 배포하고,
 *     나온 웹 앱 URL을 Findar의 .env.local에 FINDAR_SHEET_SYNC_URL로 넣는다.
 *  4. 스크립트를 고친 뒤에는 [배포 관리]에서 기존 배포를 "새 버전"으로 수정해야 반영된다(URL 유지).
 *
 * 시트 열: A 회사명 | B 지원일자 | C 이력서 버전 | D 신입/경력 | E 포지션 | F 링크 | G 단계 | H 결과
 */

var SHEET_GID = 0; // 지원 현황 탭의 gid (URL의 #gid= 값)
var HEADER_ROWS = 1;
var COL = { company: 1, appliedDate: 2, resumeVersion: 3, career: 4, position: 5, link: 6, stage: 7, result: 8 };
var RESULT_COLORS = { "탈락": "#ff6d01", "합격": "#4285f4" };

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var data = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty("FINDAR_TOKEN");
    if (!token || data.token !== token) return json({ ok: false, error: "invalid token" });
    if (!/^\d+$/.test(String(data.seq))) return json({ ok: false, error: "invalid seq" });

    lock.waitLock(20000);
    var sheet = getTargetSheet();
    var row = findRowBySeq(sheet, String(data.seq));

    if (row === -1) {
      row = sheet.getLastRow() + 1;
      // 지원일자(26-01-19)가 날짜로 자동 변환되지 않도록 텍스트 서식을 먼저 건다.
      sheet.getRange(row, COL.appliedDate).setNumberFormat("@");
      sheet.getRange(row, 1, 1, 8).setValues([[
        data.company || "",
        data.appliedDate || "",
        "", // 이력서 버전은 사용자가 직접 채운다
        data.career || "",
        data.position || "",
        data.link || "",
        data.stage || "",
        data.result || "",
      ]]);
    } else {
      // 기존 행은 단계·결과만 갱신하고, 나머지 칸은 비어 있을 때만 채운다(손으로 고친 값 보존).
      fillIfBlank(sheet, row, COL.company, data.company);
      fillIfBlank(sheet, row, COL.career, data.career);
      fillIfBlank(sheet, row, COL.position, data.position);
      if (isBlank(sheet, row, COL.appliedDate)) {
        sheet.getRange(row, COL.appliedDate).setNumberFormat("@").setValue(data.appliedDate || "");
      }
      sheet.getRange(row, COL.stage).setValue(data.stage || "");
      sheet.getRange(row, COL.result).setValue(data.result || "");
    }

    sheet.getRange(row, COL.result).setBackground(RESULT_COLORS[data.result] || null);
    return json({ ok: true, row: row });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function getTargetSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SHEET_GID) return sheets[i];
  }
  return sheets[0];
}

// 링크 칸의 텍스트나 하이퍼링크 URL에서 seq=번호를 찾는다.
function findRowBySeq(sheet, seq) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROWS) return -1;
  var range = sheet.getRange(HEADER_ROWS + 1, COL.link, lastRow - HEADER_ROWS, 1);
  var texts = range.getDisplayValues();
  var rich = range.getRichTextValues();
  for (var i = 0; i < texts.length; i++) {
    var url = rich[i][0] ? rich[i][0].getLinkUrl() : null;
    if (seqOf(texts[i][0]) === seq || seqOf(url) === seq) return HEADER_ROWS + 1 + i;
  }
  return -1;
}

function seqOf(text) {
  var m = /[?&]seq=(\d+)/.exec(text || "");
  return m ? m[1] : null;
}

function isBlank(sheet, row, col) {
  return sheet.getRange(row, col).getDisplayValue() === "";
}

function fillIfBlank(sheet, row, col, value) {
  if (value && isBlank(sheet, row, col)) sheet.getRange(row, col).setValue(value);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
