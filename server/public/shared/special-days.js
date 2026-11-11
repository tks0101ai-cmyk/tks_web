/**
 * ============================================================================
 * SPECIAL DAYS — TOKOSI DASHBOARD
 * Danh sách ngày lễ Việt Nam (dương lịch + âm lịch) và sinh nhật Nguyễn Ngọc
 * Việt Thắng. Một nguồn dữ liệu dùng chung:
 *   - Server: job thông báo chuông (notifications/specialDayNotifier.js)
 *   (Hiệu ứng sao băng / pháo hoa trên trình duyệt đã gỡ 11/11/2026.)
 * Dạng UMD (CommonJS + biến toàn cục TKSSpecialDays), không phụ thuộc thư viện.
 * Ngày luôn tính theo giờ Việt Nam (Asia/Ho_Chi_Minh), không theo múi giờ máy.
 * ============================================================================
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TKSSpecialDays = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VN_TIME_ZONE = 'Asia/Ho_Chi_Minh';
  var VN_OFFSET_HOURS = 7;

  // ---------------------------------------------------------------------------
  // Đổi dương lịch -> âm lịch (thuật toán Hồ Ngọc Đức, múi giờ +7)
  // ---------------------------------------------------------------------------
  function jdFromDate(dd, mm, yy) {
    var a = Math.floor((14 - mm) / 12);
    var y = yy + 4800 - a;
    var m = mm + 12 * a - 3;
    var jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4)
      - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    if (jd < 2299161) {
      jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
    }
    return jd;
  }

  function getNewMoonDay(k, tz) {
    var T = k / 1236.85;
    var T2 = T * T;
    var T3 = T2 * T;
    var dr = Math.PI / 180;
    var Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
    Jd1 = Jd1 + 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
    var M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
    var Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
    var F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
    var C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
    C1 = C1 - 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(dr * 2 * Mpr);
    C1 = C1 - 0.0004 * Math.sin(dr * 3 * Mpr);
    C1 = C1 + 0.0104 * Math.sin(dr * 2 * F) - 0.0051 * Math.sin(dr * (M + Mpr));
    C1 = C1 - 0.0074 * Math.sin(dr * (M - Mpr)) + 0.0004 * Math.sin(dr * (2 * F + M));
    C1 = C1 - 0.0004 * Math.sin(dr * (2 * F - M)) - 0.0006 * Math.sin(dr * (2 * F + Mpr));
    C1 = C1 + 0.0010 * Math.sin(dr * (2 * F - Mpr)) + 0.0005 * Math.sin(dr * (2 * Mpr + M));
    var deltat;
    if (T < -11) {
      deltat = 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3;
    } else {
      deltat = -0.000278 + 0.000265 * T + 0.000262 * T2;
    }
    var JdNew = Jd1 + C1 - deltat;
    return Math.floor(JdNew + 0.5 + tz / 24);
  }

  function getSunLongitude(jdn, tz) {
    var T = (jdn - 2451545.5 - tz / 24) / 36525;
    var T2 = T * T;
    var dr = Math.PI / 180;
    var M = 357.52910 + 35999.05030 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
    var L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
    var DL = (1.9146 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
    DL = DL + (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.00029 * Math.sin(dr * 3 * M);
    var L = (L0 + DL) * dr;
    L = L - Math.PI * 2 * Math.floor(L / (Math.PI * 2));
    return Math.floor(L / Math.PI * 6);
  }

  function getLunarMonth11(yy, tz) {
    var off = jdFromDate(31, 12, yy) - 2415021;
    var k = Math.floor(off / 29.530588853);
    var nm = getNewMoonDay(k, tz);
    if (getSunLongitude(nm, tz) >= 9) nm = getNewMoonDay(k - 1, tz);
    return nm;
  }

  function getLeapMonthOffset(a11, tz) {
    var k = Math.floor((a11 - 2415021.076998695) / 29.530588853 + 0.5);
    var last = 0;
    var i = 1;
    var arc = getSunLongitude(getNewMoonDay(k + i, tz), tz);
    do {
      last = arc;
      i++;
      arc = getSunLongitude(getNewMoonDay(k + i, tz), tz);
    } while (arc !== last && i < 14);
    return i - 1;
  }

  /** Trả { day, month, year, leap } âm lịch của ngày dương lịch (yy, mm, dd). */
  function solarToLunar(yy, mm, dd) {
    var tz = VN_OFFSET_HOURS;
    var dayNumber = jdFromDate(dd, mm, yy);
    var k = Math.floor((dayNumber - 2415021.076998695) / 29.530588853);
    var monthStart = getNewMoonDay(k + 1, tz);
    if (monthStart > dayNumber) monthStart = getNewMoonDay(k, tz);
    var a11 = getLunarMonth11(yy, tz);
    var b11 = a11;
    var lunarYear;
    if (a11 >= monthStart) {
      lunarYear = yy;
      a11 = getLunarMonth11(yy - 1, tz);
    } else {
      lunarYear = yy + 1;
      b11 = getLunarMonth11(yy + 1, tz);
    }
    var lunarDay = dayNumber - monthStart + 1;
    var diff = Math.floor((monthStart - a11) / 29);
    var lunarLeap = 0;
    var lunarMonth = diff + 11;
    if (b11 - a11 > 365) {
      var leapMonthDiff = getLeapMonthOffset(a11, tz);
      if (diff >= leapMonthDiff) {
        lunarMonth = diff + 10;
        if (diff === leapMonthDiff) lunarLeap = 1;
      }
    }
    if (lunarMonth > 12) lunarMonth -= 12;
    if (lunarMonth >= 11 && diff < 4) lunarYear -= 1;
    return { day: lunarDay, month: lunarMonth, year: lunarYear, leap: lunarLeap };
  }

  // ---------------------------------------------------------------------------
  // Danh mục ngày đặc biệt
  // ---------------------------------------------------------------------------
  var BIRTHDAY_NAME = 'Nguyễn Ngọc Việt Thắng';

  // Dương lịch cố định, khoá "MM-DD".
  var SOLAR_DAYS = {
    '01-01': { key: 'new_year', type: 'holiday', title: '🎆 Chào năm mới', message: 'Chào đón năm mới! TOKOSI kính chúc toàn thể anh chị em và gia đình một năm mới dồi dào sức khỏe, an khang thịnh vượng, vạn sự như ý và cùng nhau chinh phục những đỉnh cao mới rực rỡ!' },
    '03-08': { key: 'womens_day', type: 'holiday', title: '🌸 Quốc tế Phụ nữ 8/3', message: 'Nhân ngày Quốc tế Phụ nữ 8/3, TOKOSI xin trân trọng gửi lời tri ân sâu sắc và chúc các chị em luôn xinh đẹp, rạng ngời, ngập tràn hạnh phúc và luôn là nguồn cảm hứng ấm áp, tuyệt vời trong công việc cũng như cuộc sống!' },
    '04-30': { key: 'reunification_day', type: 'holiday', title: '🇻🇳 Ngày Giải phóng miền Nam 30/4', message: 'Kỷ niệm Ngày Giải phóng miền Nam, thống nhất đất nước 30/4! Hòa trong niềm tự hào non sông liền một dải, TOKOSI chúc toàn thể anh chị em có một kỳ nghỉ lễ thật ý nghĩa, trọn vẹn niềm vui và ấm áp bên gia đình người thân!' },
    '05-01': { key: 'labour_day', type: 'holiday', title: '🛠️ Quốc tế Lao động 1/5', message: 'Chào mừng Ngày Quốc tế Lao động 1/5! TOKOSI xin gửi lời cảm ơn chân thành đến những đóng góp bền bỉ và tâm huyết của toàn thể anh chị em. Chúc đại gia đình một kỳ nghỉ lễ thật thoải mái, thư thái và tái tạo năng lượng dồi dào!' },
    '09-02': { key: 'national_day', type: 'holiday', title: '🇻🇳 Quốc khánh 2/9', message: 'Nhiệt liệt chào mừng Ngày Quốc khánh nước Cộng hòa Xã hội Chủ nghĩa Việt Nam 2/9! Chúc toàn thể anh chị em có một kỳ nghỉ Tết Độc lập thật nhiều niềm vui, bình an và hạnh phúc bên những người thân yêu!' },
    '10-20': { key: 'vn_womens_day', type: 'holiday', title: '🌹 Ngày Phụ nữ Việt Nam 20/10', message: 'Chào mừng ngày Phụ nữ Việt Nam 20/10! Cảm ơn những cống hiến, tâm huyết và sự duyên dáng mà các chị em mang đến cho đại gia đình TOKOSI. Chúc các chị em luôn dồi dào năng lượng, công việc thuận lợi và gặt hái thật nhiều thành công!' },
    '10-27': { key: 'birthday_thang', type: 'birthday', title: '🎂 Sinh nhật', notify: false },
    '11-19': { key: 'mens_day', type: 'holiday', title: '🎩 Ngày Quốc tế Nam giới 19/11', message: 'Nhân ngày Quốc tế Nam giới 19/11, TOKOSI xin gửi lời chúc mừng nồng nhiệt nhất đến toàn thể các anh em! Chúc các đấng mày râu luôn tràn đầy bản lĩnh, dồi dào sức khỏe, luôn vững vàng phong độ và gặt hái được nhiều thành công rực rỡ trong công việc lẫn cuộc sống!' },
    '11-20': { key: 'teachers_day', type: 'holiday', title: '📚 Ngày Nhà giáo Việt Nam 20/11', message: 'Nhân ngày Nhà giáo Việt Nam 20/11, TOKOSI xin trân trọng tri ân những người thầy, người cô cùng những người dẫn dắt thầm lặng trong công việc và cuộc sống. Kính chúc quý thầy cô luôn mạnh khỏe, hạnh phúc và giữ trọn ngọn lửa nhiệt huyết với sự nghiệp trồng người!' },
    '12-25': { key: 'christmas', type: 'holiday', title: '🎄 Giáng sinh', message: 'Giáng sinh an lành và ấm áp! TOKOSI thân chúc toàn thể anh chị em cùng gia đình đón một mùa Noel ngập tràn tiếng cười, đong đầy yêu thương, an yên và đón nhận những điều kỳ diệu tươi đẹp nhất!' }
  };

  // Âm lịch, khoá "tháng-ngày" (chỉ tháng thường, không tính tháng nhuận).
  var LUNAR_DAYS = {
    '1-1': { key: 'tet_1', type: 'holiday', title: '🧧 Mùng 1 Tết Nguyên đán', message: 'Mùng 1 Tết Nguyên đán: Khởi đầu một mùa xuân mới rạng rỡ, TOKOSI kính chúc toàn thể anh chị em và gia đình một năm mới An khang thịnh vượng, Vạn sự như ý, Sức khỏe dồi dào và Đắc tài đắc lộc!' },
    '1-2': { key: 'tet_2', type: 'holiday', title: '🧧 Mùng 2 Tết Nguyên đán', message: 'Mùng 2 Tết Nguyên đán: TOKOSI thân chúc toàn thể anh chị em những ngày đầu xuân ngập tràn tiếng cười, gia đạo bình an, gặp nhiều may mắn và thắt chặt tình thân bên gia đình, bè bạn!' },
    '1-3': { key: 'tet_3', type: 'holiday', title: '🧧 Mùng 3 Tết Nguyên đán', message: 'Mùng 3 Tết Nguyên đán: Chúc toàn thể anh chị em trọn vẹn niềm vui sum vầy, tinh thần phấn chấn, nạp đầy khí thế để cùng sẵn sàng cho một năm mới bứt phá mạnh mẽ, công việc hanh thông và tài lộc dồi dào!' },
    '3-10': { key: 'hung_kings', type: 'holiday', title: '🏯 Giỗ Tổ Hùng Vương 10/3 âm lịch', message: 'Tưởng nhớ cội nguồn dân tộc - Ngày Giỗ Tổ Hùng Vương mùng 10 tháng 3 âm lịch: "Dù ai đi ngược về xuôi, nhớ ngày Giỗ Tổ mùng mười tháng ba." TOKOSI kính chúc anh chị em cùng gia đình một ngày lễ ý nghĩa, an vui và trân quý từng phút giây sum họp!' },
    '8-15': { key: 'mid_autumn', type: 'holiday', title: '🥮 Tết Trung thu', message: 'Tết Trung thu sum vầy và đoàn viên! TOKOSI chúc toàn thể anh chị em cùng gia đình và các bé có một đêm hội trăng rằm rộn rã niềm vui, ngọt ngào bánh nướng, bánh dẻo và ấm áp trọn vẹn bên mâm cỗ đoàn viên!' }
  };

  var TET_EVE = { key: 'tet_eve', type: 'holiday', title: '🧧 Giao thừa', message: 'Khoảnh khắc thiêng liêng chuyển giao năm mới - Đêm Giao thừa! TOKOSI kính chúc toàn thể anh chị em cùng gia đình một đêm trừ tịch đoàn viên ấm áp, khép lại năm cũ trọn vẹn và sẵn sàng đón chào năm mới bình an, cát tường, vạn sự hanh thông!' };

  function parseKey(dateKey) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }

  function nextDayParts(p) {
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  /**
   * Ngày đặc biệt của dateKey ('YYYY-MM-DD', đã là ngày VN) hoặc null.
   * Ưu tiên: dương lịch/sinh nhật trước, rồi âm lịch, cuối cùng Giao thừa.
   */
  function getSpecialDay(dateKey) {
    var p = parseKey(dateKey);
    if (!p) return null;
    var mm = ('0' + p.m).slice(-2);
    var dd = ('0' + p.d).slice(-2);
    var solar = SOLAR_DAYS[mm + '-' + dd];
    if (solar) return Object.assign({ dateKey: dateKey }, solar);

    var lunar = solarToLunar(p.y, p.m, p.d);
    if (!lunar.leap) {
      var hit = LUNAR_DAYS[lunar.month + '-' + lunar.day];
      if (hit) return Object.assign({ dateKey: dateKey }, hit);
    }

    // Giao thừa = ngày liền trước mùng 1 Tết (29 hoặc 30 tháng Chạp).
    var nx = nextDayParts(p);
    var nextLunar = solarToLunar(nx.y, nx.m, nx.d);
    if (nextLunar.month === 1 && nextLunar.day === 1 && !nextLunar.leap) {
      return Object.assign({ dateKey: dateKey }, TET_EVE);
    }
    return null;
  }

  /** 'YYYY-MM-DD' của thời điểm `now` theo giờ Việt Nam. */
  function todayKey(now) {
    var date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: VN_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  function getSpecialToday(now) {
    return getSpecialDay(todayKey(now));
  }

  return {
    VN_TIME_ZONE: VN_TIME_ZONE,
    BIRTHDAY_NAME: BIRTHDAY_NAME,
    solarToLunar: solarToLunar,
    getSpecialDay: getSpecialDay,
    getSpecialToday: getSpecialToday,
    todayKey: todayKey
  };
});
