/* 门店端导购目标：按日期、渠道校验完整有效分配，金额以分计算。 */
(function (root) {
  const channels = {
    pos: { field: 'assistantDayGoal', storeField: 'storeDayGoal', label: 'POS销售日目标' },
    domain: { field: 'domainDayGoal', storeField: 'domainDayGoal', label: '私域销售日目标' }
  };
  const reasons = { storeAdjusted: '门店目标调整' };
  function date(value) {
    const digits = String(value || '').replace(/[-/]/g, '');
    if (!/^\d{8}$/.test(digits)) throw new Error('请选择有效的考核日期。');
    const y = Number(digits.slice(0, 4)), m = Number(digits.slice(4, 6)), d = Number(digits.slice(6));
    if (y < 1900 || m < 1 || m > 12 || d < 1 || d > new Date(y, m, 0).getDate()) throw new Error('考核日期无效。');
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
  }
  function cents(value, label = '目标金额') {
    const text = String(value ?? '').trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label}须为非负金额，最多保留2位小数，且不能为空。`);
    const [whole, decimal = ''] = text.replace(/,/g, '').split('.');
    const amount = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount)) throw new Error(`${label}超出允许范围。`);
    return amount;
  }
  function active(row) { return row.isArchived !== '1' && ['SUBMIT', 'UNSUBMIT'].includes(row.status); }
  function storeGoal(storeRows, day) {
    const matches = storeRows.filter(row => date(row.assessmentDay) === date(day));
    if (matches.length !== 1) throw new Error(`${date(day)}：${matches.length ? '门店日目标重复，请先核对' : '尚未设置门店日目标，请先维护门店目标'}。`);
    const row = matches[0];
    return { pos: cents(row.storeDayGoal, '门店POS目标'), domain: cents(row.domainDayGoal, '门店私域目标') };
  }
  function totals(rows, day) {
    const result = { pos: 0, domain: 0 };
    rows.filter(row => date(row.assessmentDay) === date(day) && active(row)).forEach(row => {
      Object.entries(channels).forEach(([key, channel]) => { result[key] += cents(row[channel.field], `${row.assistantName || row.assistantCode}${channel.label}`); });
    });
    if (!Object.values(result).every(Number.isSafeInteger)) throw new Error('导购合计金额超出允许范围。');
    return result;
  }
  function differences(storeRows, rows, day, selected = ['pos', 'domain']) {
    const expected = storeGoal(storeRows, day), allocated = totals(rows, day);
    return selected.filter(key => expected[key] !== allocated[key]).map(key => {
      const delta = allocated[key] - expected[key];
      return `${date(day)} ${channels[key].label}：导购合计${(allocated[key] / 100).toFixed(2)}元，门店目标${(expected[key] / 100).toFixed(2)}元，差额${delta > 0 ? '+' : ''}${(delta / 100).toFixed(2)}元。`;
    });
  }
  // 先生成整批结果再校验，未导入人员沿用原值，失效和归档记录不参与合计。
  function prepare(storeRows, rows, roster, patches, selected = ['pos', 'domain']) {
    if (!patches.length) throw new Error('没有可保存的导购目标。');
    const next = rows.map(row => ({ ...row }));
    const seen = new Set(), days = new Set();
    let id = Math.max(0, ...rows.map(row => Number(row.id) || 0)) + 1;
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    patches.forEach(patch => {
      const day = date(patch.assessmentDay), key = `${day}|${patch.assistantCode}`;
      if (seen.has(key)) throw new Error(`${day} 导购${patch.assistantCode}重复出现。`);
      seen.add(key); days.add(day);
      const person = roster.find(item => item.assistantCode === patch.assistantCode);
      if (!person) throw new Error(`${day}：导购${patch.assistantCode}不属于当前门店有效人员。`);
      const expected = storeGoal(storeRows, day);
      const matches = next.filter(row => date(row.assessmentDay) === day && row.assistantCode === patch.assistantCode && active(row));
      if (matches.length > 1) throw new Error(`${day} 导购${patch.assistantCode}存在重复有效目标，请先核对。`);
      let row = matches[0];
      if (!row) {
        row = { ...person, id: id++, assessmentDay: day, assistantDayGoal: 0, domainDayGoal: 0, isArchived: '0', invalidReason: '-' };
        next.push(row);
      }
      selected.forEach(channel => { row[channels[channel].field] = cents(patch[channels[channel].field], `${day} ${person.assistantName}${channels[channel].label}`) / 100; });
      row.totalDayGoal = (cents(row.assistantDayGoal) + cents(row.domainDayGoal)) / 100;
      row.storePosDayGoal = expected.pos / 100; row.storeDomainDayGoal = expected.domain / 100;
      row.storeTotalGoal = (expected.pos + expected.domain) / 100;
      row.status = 'UNSUBMIT'; row.statusName = '未提交';
      row.invalidReason = '-'; row.updateUser = '陈店长'; row.updateTime = stamp;
    });
    const errors = [...days].flatMap(day => differences(storeRows, next, day, selected));
    if (errors.length) throw new Error('保存失败，整批数据未修改。导购目标合计必须等于对应门店日目标：\n' + errors.join('\n'));
    days.forEach(day => {
      const expected = storeGoal(storeRows, day);
      const complete = differences(storeRows, next, day).length === 0;
      next.filter(row => date(row.assessmentDay) === day && active(row)).forEach(row => {
        row.storePosDayGoal = expected.pos / 100; row.storeDomainDayGoal = expected.domain / 100; row.storeTotalGoal = (expected.pos + expected.domain) / 100;
        row.status = complete ? 'SUBMIT' : 'UNSUBMIT'; row.statusName = complete ? '已提交' : '未提交';
      });
    });
    return next;
  }
  function parseWorkbook(XLSX, workbook, channel) {
    const patches = [], seen = new Set();
    workbook.SheetNames.forEach(name => {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
      if (!rows.some(row => row.some(value => String(value).trim()))) return;
      const headerIndex = rows.findIndex(row => row.includes('年月') && row.includes('导购编号'));
      if (headerIndex < 0) throw new Error(`工作表“${name}”缺少年月或导购编号，请使用导入模板。`);
      const headers = rows[headerIndex].map(value => String(value).trim());
      const columns = headers.map((header, col) => ({ match: header.match(/^(\d{1,2})日$/), col })).filter(item => item.match);
      if (!columns.length) throw new Error(`工作表“${name}”缺少日目标列。`);
      const columnDays = columns.map(item => Number(item.match[1]));
      if (new Set(columnDays).size !== columnDays.length || columnDays.some(day => day < 1 || day > 31)) throw new Error(`工作表“${name}”日期列重复或无效。`);
      rows.slice(headerIndex + 1).forEach((row, index) => {
        if (!row.some(value => String(value).trim())) return;
        const location = `工作表“${name}”第${headerIndex + index + 2}行`;
        const month = String(row[headers.indexOf('年月')] || '').trim().replace(/[-/年月]/g, '');
        const assistantCode = String(row[headers.indexOf('导购编号')] || '').trim();
        if (!/^\d{6}$/.test(month) || !assistantCode) throw new Error(`${location}：请填写有效年月和导购编号。`);
        date(month + '01');
        const key = `${month}|${assistantCode}`;
        if (seen.has(key)) throw new Error(`${location}：同一导购同一月份只能填写一行。`);
        seen.add(key);
        const length = new Date(Number(month.slice(0, 4)), Number(month.slice(4)), 0).getDate();
        columns.forEach(({ match, col }) => {
          const day = Number(match[1]), value = row[col];
          const cell = sheet[XLSX.utils.encode_cell({ r: headerIndex + index + 1, c: col })];
          if (cell && (cell.f || cell.t === 'e')) throw new Error(`${location} ${day}日：请填写金额值，不使用公式或错误值。`);
          if (value === '' || value === undefined || value === null) return;
          const amount = cents(value, `${location} ${day}日目标`);
          if (day > length) {
            if (amount !== 0) throw new Error(`${location}：该月份不存在${day}日。`);
            return;
          }
          patches.push({ assessmentDay: date(month + String(day).padStart(2, '0')), assistantCode, [channels[channel].field]: amount / 100 });
        });
      });
    });
    if (!patches.length) throw new Error('文件没有可导入的目标金额。空白表示不修改，填0表示清零。');
    return patches;
  }
  const api = { channels, reasons, date, cents, active, storeGoal, totals, differences, prepare, parseWorkbook };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AssistantGoalRules = api;
})(typeof window === 'undefined' ? globalThis : window);
