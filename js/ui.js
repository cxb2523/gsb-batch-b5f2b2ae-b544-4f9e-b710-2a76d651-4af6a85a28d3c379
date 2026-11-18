/**
 * UI 模块
 * 负责 DOM 操作、渲染更新、事件绑定、动画触发
 */

// 说明：CASE_VALUES / ROUND_CONFIG / TOTAL_ROUNDS / LOW_VALUE_COUNT /
// GAME_PHASE / CASE_STATE / formatCurrency / getValueClass / getValueLabel
// 由 config.js 全局提供；StateManager 由 state.js 全局提供；
// getOfferCommentary 由 banker.js 全局提供（formatOfferForDisplay 已移除，见 banker.js）。
// 本项目使用普通脚本加载，此处不再使用 import。

// ========================================
// DOM 元素缓存
// ========================================
const elements = {};

// ========================================
// 对局代次（UI 层）与统一调度器
// ----------------------------------------------------------------
// 所有会改动 DOM 的延迟回调（动画收尾、弹窗进出场、遮罩隐藏、揭示动画……）
// 都必须经由 scheduleUI() 注册，并在执行前核对创建时的 epoch。
// resetUI()（重开/初始化）会递增 epoch，使上一局残留的全部定时器立即失效，
// 不再有任何旧回调能改动新局的弹窗、遮罩、按钮或箱子。
// 该代次与 GameController.generation 在每次重开时同步递增，互为双保险。
// ========================================
let uiEpoch = 0;
let activeUITimers = new Set();

/**
 * 注册一个受对局代次保护的延迟回调。
 * @param {Function} fn - 回调；仅当回调触发时代次未变化才会执行
 * @param {number} delay - 延迟毫秒数
 * @returns {number} 定时器 id
 */
function scheduleUI(fn, delay) {
    const epoch = uiEpoch;
    const id = setTimeout(() => {
        activeUITimers.delete(id);
        // 重开/初始化后旧代次回调一律作废，绝不触碰新局 DOM
        if (epoch !== uiEpoch) return;
        fn();
    }, delay);
    activeUITimers.add(id);
    return id;
}

/**
 * 使当前所有挂起的 UI 定时器失效并清空登记。
 * 注意：不 clearTimeout——让其到时自行空转返回，避免把动画 Promise 永远挂起
 * （await 动画的控制器流程随后还会用 GameController.generation 再次拦截）。
 */
function invalidateUITimers() {
    uiEpoch++;
    activeUITimers.clear();
}

/** 当前 UI 代次（供动画函数捕获并在异步收尾时核对） */
function currentUIEpoch() {
    return uiEpoch;
}

// 缓存常用 DOM 元素
function cacheElements() {
    elements.themeToggle = document.getElementById('theme-toggle');
    elements.themeMenu = document.getElementById('theme-menu');
    elements.themeCurrentIcon = document.getElementById('theme-current-icon');
    elements.lowMoneyList = document.getElementById('low-money-list');
    elements.highMoneyList = document.getElementById('high-money-list');
    elements.casesGrid = document.getElementById('cases-grid');
    elements.playerCaseDisplay = document.getElementById('player-case-display');
    elements.playerCaseNumber = document.getElementById('player-case-number');
    elements.playerCaseBox = document.getElementById('player-case-box');
    elements.roundInfo = document.getElementById('round-info');
    elements.roundCurrent = document.getElementById('round-current');
    elements.roundTarget = document.getElementById('round-target');
    elements.roundProgress = document.getElementById('round-progress');
    elements.bankerModal = document.getElementById('banker-modal');
    elements.bankerOfferAmount = document.getElementById('banker-offer-amount');
    elements.bankerExpected = document.getElementById('banker-expected');
    elements.bankerExpectedValue = document.getElementById('banker-expected-value');
    elements.btnDeal = document.getElementById('btn-deal');
    elements.btnNoDeal = document.getElementById('btn-no-deal');
    // 讨价还价（还价）相关元素
    elements.btnHaggle = document.getElementById('btn-haggle');
    elements.bankerHaggle = document.getElementById('banker-haggle');
    elements.bankerHagglePanel = document.getElementById('banker-haggle-panel');
    elements.bankerHaggleInput = document.getElementById('banker-haggle-input');
    elements.btnHaggleSubmit = document.getElementById('btn-haggle-submit');
    elements.btnHaggleCancel = document.getElementById('btn-haggle-cancel');
    elements.bankerHaggleResult = document.getElementById('banker-haggle-result');
    elements.bankerCommentary = document.getElementById('banker-commentary');
    elements.switchModal = document.getElementById('switch-modal');
    elements.switchPlayerCaseNum = document.getElementById('switch-player-case-num');
    elements.switchOtherCaseNum = document.getElementById('switch-other-case-num');
    elements.btnKeep = document.getElementById('btn-keep');
    elements.btnSwitch = document.getElementById('btn-switch');
    elements.resultModal = document.getElementById('result-modal');
    elements.resultSummary = document.getElementById('result-summary');
    elements.resultDetails = document.getElementById('result-details');
    // 缓存各弹窗的内容层（真正居中定位、加动画的元素）
    elements.bankerModalContent = elements.bankerModal ? elements.bankerModal.querySelector('.modal-content') : null;
    elements.switchModalContent = elements.switchModal ? elements.switchModal.querySelector('.modal-content') : null;
    elements.resultModalContent = elements.resultModal ? elements.resultModal.querySelector('.modal-content') : null;
    elements.btnRestart = document.getElementById('btn-restart');
    elements.instructionBanner = document.getElementById('instruction-banner');
    elements.modalBackdrop = document.getElementById('modal-backdrop');

    // 语言切换相关元素
    elements.langToggle = document.getElementById('lang-toggle');
    elements.langMenu = document.getElementById('lang-menu');
    elements.langCurrentIcon = document.getElementById('lang-current-icon');

    // 开发者选项（彩蛋）相关元素
    elements.gameTitle = document.getElementById('game-title');
    elements.devModal = document.getElementById('dev-modal');
    elements.devModalContent = elements.devModal ? elements.devModal.querySelector('.modal-content') : null;
    elements.btnDevAll = document.getElementById('btn-dev-all');
    elements.btnDevRemaining = document.getElementById('btn-dev-remaining');
    elements.btnDevMine = document.getElementById('btn-dev-mine');
    elements.btnDevClose = document.getElementById('btn-dev-close');
    elements.devResult = document.getElementById('dev-result');
}

// 期望值白话解释统一通过 i18n 的 'ev.explainer' 取词（见 buildResultContent 与 index.html 的 data-i18n）

// ========================================
// 渲染函数
// ========================================

/**
 * 渲染金额面板（左右两侧）
 */
function renderMoneyPanels() {
    const state = StateManager.getState();
    const openedValues = new Set(Array.from(state.openedCases.values()));

    const lowValues = CASE_VALUES.slice(0, LOW_VALUE_COUNT);
    const highValues = CASE_VALUES.slice(LOW_VALUE_COUNT);

    // 只展示“公开奖阶”（哪些金额已被开走）；绝不标出“哪个金额是你的箱子”，
    // 否则玩家能直接看到自己箱子的真实金额，违背 README“金额整局保持隐藏”的设计。
    elements.lowMoneyList.innerHTML = lowValues.map(value => {
        const isOpened = openedValues.has(value);
        const className = `money-item ${isOpened ? 'money-item--opened' : ''}`;
        return `<li class="${className}" data-value="${value}">
            <span class="money-item__label">${getValueLabel(value)}</span>
            <span class="money-item__value">${formatCurrency(value)}</span>
        </li>`;
    }).join('');

    elements.highMoneyList.innerHTML = highValues.map(value => {
        const isOpened = openedValues.has(value);
        const className = `money-item ${isOpened ? 'money-item--opened' : ''}`;
        return `<li class="${className}" data-value="${value}">
            <span class="money-item__label">${getValueLabel(value)}</span>
            <span class="money-item__value">${formatCurrency(value)}</span>
        </li>`;
    }).join('');
}

/**
 * 高亮特定金额（开箱时调用）
 * @param {number} value - 要高亮的金额
 */
function highlightMoneyValue(value) {
    const selector = `.money-item[data-value="${value}"]`;
    const item = document.querySelector(selector);
    if (item) {
        item.classList.add('money-item--animating');
        // 动画结束后移除高亮类，添加已开启类。
        // 受对局代次保护：重开后金额面板已整体重渲染，旧回调不得再操作新面板节点。
        scheduleUI(() => {
            const stillItem = document.querySelector(selector);
            if (!stillItem) return;
            stillItem.classList.remove('money-item--animating');
            stillItem.classList.add('money-item--opened');
        }, 1200);
    }
}

// ========================================
// 弹窗 / 遮罩统一管理
// ----------------------------------------------------------------
// 遮罩的显隐只能由“当前真正打开的弹窗”决定，杜绝各自计时导致的
// “弹窗无背景”或“遮罩提前消失”。
// ========================================

// 弹窗 -> 其最外层容器的映射（开发者选项弹窗也纳入统一管理）
function _modalRoots() {
    return [
        elements.bankerModal,
        elements.switchModal,
        elements.resultModal,
        elements.devModal
    ].filter(Boolean);
}

/** 当前是否还有任一弹窗处于打开状态（以 hidden 属性为准） */
function isAnyModalOpen() {
    return _modalRoots().some(modal => !modal.hidden);
}

/**
 * 按当前真正打开的弹窗同步遮罩状态。
 * - 有弹窗打开：遮罩必须显示（若此前被退场动画隐藏则重新拉起）；
 * - 无弹窗打开：遮罩必须隐藏。
 * 可被任意流程安全重复调用，是遮罩状态的唯一裁决点。
 */
function syncBackdrop() {
    const backdrop = elements.modalBackdrop;
    if (!backdrop) return;
    if (isAnyModalOpen()) {
        if (backdrop.hidden) {
            backdrop.hidden = false;
            backdrop.classList.remove('modal-backdrop-exit');
            backdrop.classList.add('modal-backdrop-enter');
        }
    } else {
        backdrop.hidden = true;
        backdrop.classList.remove('modal-backdrop-enter', 'modal-backdrop-exit');
    }
}

/**
 * 渲染 26 个箱子网格
 */
function renderCasesGrid() {
    const state = StateManager.getState();
    const numbers = Array.from({ length: 26 }, (_, i) => i + 1);

    elements.casesGrid.innerHTML = numbers.map(num => {
        if (state.playerCaseNumber && num === state.playerCaseNumber) {
            // 玩家箱子已移到侧边面板：保留一个占位格在原编号位置，
            // 既避免网格末端出现空洞，也保证剩余箱子编号位置不漂移
            return '<div class="case case--placeholder" aria-hidden="true"></div>';
        }

        const isOpened = state.openedCases.has(num);
        const value = state.caseAssignments.get(num);
        const valueClass = getValueClass(value);

        let cssClass = 'case';
        let innerHTML = '';

        if (isOpened) {
            // 已开箱：值已揭晓，可安全展示（含高/低配色）
            cssClass += ` case--opened case--${valueClass}`;
            innerHTML = `
                <div class="case__inner">
                    <div class="case__front">
                        <span class="case__number">${num}</span>
                    </div>
                    <div class="case__back case--${valueClass}">
                        <span class="case__value">${formatCurrency(value)}</span>
                    </div>
                </div>`;
        } else {
            // 未开箱：背面的金额与高/低配色都不要写进 DOM，
            // 否则玩家可用开发者工具提前看到每个箱子的真实金额（泄密）。
            // 金额仅在 animateCaseOpen 翻转那一刻由 JS 注入。
            cssClass += ' case--unopened';
            innerHTML = `
                <div class="case__inner">
                    <div class="case__front">
                        <span class="case__number">${num}</span>
                    </div>
                    <div class="case__back">
                        <span class="case__value"></span>
                    </div>
                </div>`;
        }

        const interactAttrs = isOpened
            ? `tabindex="-1" aria-hidden="true"`
            : `role="button" tabindex="0" aria-label="${t('case.aria', { n: num })}" aria-pressed="false"`;
        return `<div class="${cssClass}" data-number="${num}" ${interactAttrs}>${innerHTML}</div>`;
    }).join('');
}

/**
 * 触发箱子翻转动画
 * @param {number} caseNumber - 箱子编号
 * @param {number} value - 箱子金额
 * @returns {Promise} 动画完成 Promise
 */
function animateCaseOpen(caseNumber, value) {
    return new Promise(resolve => {
        const caseEl = document.querySelector(`.case[data-number="${caseNumber}"]`);
        if (!caseEl) { resolve(); return; }

        // 捕获对局代次：重开后网格已整体重建，旧动画收尾不得再操作新棋盘的箱子
        const epoch = currentUIEpoch();

        // 添加翻转类
        caseEl.classList.add('case--flipping');
        caseEl.classList.remove('case--unopened');

        // 更新金额显示
        const valueEl = caseEl.querySelector('.case__value');
        if (valueEl) {
            valueEl.textContent = formatCurrency(value);
            valueEl.className = `case__value case--${getValueClass(value)}`;
        }

        // 动画结束后更新类。
        // 直接使用裸定时器并始终 resolve：代次失效时仅放弃 DOM 操作，
        // 避免 await 本动画的控制器协程被永久挂起（控制器侧还有 generation 二次拦截）。
        setTimeout(() => {
            if (epoch !== currentUIEpoch()) { resolve(); return; }
            const el = document.querySelector(`.case[data-number="${caseNumber}"]`);
            if (!el) { resolve(); return; }
            el.classList.remove('case--flipping');
            el.classList.add('case--opened', `case--${getValueClass(value)}`);
            el.removeAttribute('role');
            el.removeAttribute('tabindex');
            el.style.cursor = 'default';
            resolve();
        }, 800); // 与 CSS 动画时长一致
    });
}

/**
 * 显示玩家选择的箱子
 * @param {number} caseNumber
 * @param {number} value
 */
/**
 * 玩家选定箱子后统一准备"你的箱子"显示区（编号、显示区、轮次信息）。
 * 正常飞行路径与降动效降级路径共用此函数，避免两份逻辑分叉（修复 BUG-C）。
 * @param {number} caseNumber
 * @param {boolean} fillBox 是否立即把编号写入玩家箱子盒子（降级路径填；飞行路径留空等克隆体抵达）
 * @param {boolean} hideBanner 是否立即隐藏指示横幅（降级路径隐藏；飞行路径交由 animateBannerOut 平滑离场）
 */
function preparePlayerCaseDisplay(caseNumber, fillBox, hideBanner) {
    // 重新获取玩家箱子编号元素（可能被之前的 innerHTML 替换而失效，修复 Bug #4 相关）
    const numEl = elements.playerCaseBox.querySelector('.player-case__number')
               || document.getElementById('player-case-number');
    if (numEl) numEl.textContent = caseNumber;
    elements.playerCaseDisplay.hidden = false;
    elements.roundInfo.hidden = false;
    updateRoundInfo();
    if (hideBanner) elements.instructionBanner.hidden = true;
    if (fillBox) {
        elements.playerCaseBox.innerHTML = `<span class="player-case__number">${caseNumber}</span>`;
    }
}

/**
 * 玩家选定箱子时的飞行动画与选择区过渡
 * - 被点中的箱子以克隆体从网格"飞"到"你的箱子"区域
 * - 指示横幅平滑离场
 * - 剩余箱子轻柔落位
 * @param {number} caseNumber
 * @param {number} value
 * @returns {Promise} 动画完成 Promise
 */
async function animatePlayerCaseSelection(caseNumber, value) {
    const prefersReduced = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const sourceEl = elements.casesGrid.querySelector(`.case[data-number="${caseNumber}"]`);

    // 捕获对局代次：飞行途中若重开，新局棋盘与玩家箱已重置，
    // 旧动画的任何收尾都不得再写入新局 DOM
    const epoch = currentUIEpoch();

    // 降级：无来源元素或用户偏好减少动画时，直接显示，不做飞行
    if (prefersReduced || !sourceEl) {
        renderCasesGrid(); // 仍需重渲染，将玩家箱子移出中央网格
        // 降级路径：直接填充编号并隐藏横幅/显示轮次信息（复用同一 helper，修复 BUG-C）
        preparePlayerCaseDisplay(caseNumber, true, true);
        return;
    }

    // 1) 记录起点位置
    const sourceRect = sourceEl.getBoundingClientRect();

    // 2) 创建飞行克隆体，覆盖在原点（样式与箱子正面一致）
    const flying = document.createElement('div');
    flying.className = 'case-fly';
    flying.innerHTML = `
        <div class="case__inner">
            <div class="case__front">
                <span class="case__number">${caseNumber}</span>
            </div>
        </div>`;
    Object.assign(flying.style, {
        left: sourceRect.left + 'px',
        top: sourceRect.top + 'px',
        width: sourceRect.width + 'px',
        height: sourceRect.height + 'px',
        margin: '0'
    });
    document.body.appendChild(flying);

    // 3) 立即重渲染网格（玩家箱子被移除）；克隆体覆盖原位，视觉无缝
    renderCasesGrid();

    // 4) 准备"你的箱子"区域，但先留空占位，等待克隆体抵达
    //    preparePlayerCaseDisplay 统一处理编号/显示区/轮次信息（与降级路径共用，修复 BUG-C）；
    //    横幅的平滑离场仍交由下方 animateBannerOut() 负责，此处不立即隐藏。
    preparePlayerCaseDisplay(caseNumber, false, false);
    elements.playerCaseBox.innerHTML = '';
    elements.playerCaseBox.classList.add('player-case__box--incoming');

    // 轮次信息显示（沿用基础 slideUp 动画）—— 已由 preparePlayerCaseDisplay 内部完成

    // 指示横幅平滑离场
    animateBannerOut();

    // 网格其余箱子轻柔落位
    elements.casesGrid.classList.add('is-settling');

    // 5) 计算目标位置（"你的箱子"盒子），仅透明度动画不影响布局定位
    void elements.playerCaseBox.offsetWidth; // 强制布局
    const targetRect = elements.playerCaseBox.getBoundingClientRect();

    const dx = targetRect.left - sourceRect.left;
    const dy = targetRect.top - sourceRect.top;
    const scale = targetRect.width / sourceRect.width;

    // 6) 触发飞行（下一帧再设置 transform，确保过渡生效）
    requestAnimationFrame(() => {
        flying.style.transformOrigin = 'top left';
        flying.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    });

    // 7) 飞行结束后揭示真实盒子并移除克隆体
    await new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            flying.removeEventListener('transitionend', finish);

            // 重开/初始化使代次变化：新局已重置玩家箱与网格，
            // 只清理本动画创建的飞行克隆体，不再触碰新局任何元素
            if (epoch !== currentUIEpoch()) {
                if (flying.parentNode) flying.parentNode.removeChild(flying);
                resolve();
                return;
            }

            elements.playerCaseBox.innerHTML = `<span class="player-case__number">${caseNumber}</span>`;
            elements.playerCaseBox.classList.remove('player-case__box--incoming');
            elements.playerCaseBox.classList.add('player-case__box--arrived');

            if (flying.parentNode) flying.parentNode.removeChild(flying);

            // 清理临时类，恢复基础发光/落位动画（代次保护，防止重开后清理新局类名）
            scheduleUI(() => {
                elements.playerCaseBox.classList.remove('player-case__box--arrived');
                elements.casesGrid.classList.remove('is-settling');
            }, 550);

            resolve();
        };
        flying.addEventListener('transitionend', finish);
        setTimeout(finish, 800); // 兜底，避免 transitionend 未触发
    });
}

/**
 * 指示横幅平滑离场（动画结束后隐藏，避免生硬跳变）
 */
function animateBannerOut() {
    const b = elements.instructionBanner;
    const epoch = currentUIEpoch();
    b.classList.add('instruction-banner--leaving');
    const onEnd = () => {
        // 重开后横幅由 resetUI 复位显示，旧离场回调不得再隐藏新局横幅
        if (epoch !== currentUIEpoch()) return;
        b.removeEventListener('animationend', onEnd);
        b.hidden = true;
        b.classList.remove('instruction-banner--leaving');
    };
    b.addEventListener('animationend', onEnd);
    // 兜底（同样受代次保护）
    scheduleUI(onEnd, 600);
}

/**
 * 更新轮次信息显示
 */
function updateRoundInfo() {
    const state = StateManager.getState();
    const roundInfo = StateManager.getCurrentRoundInfo();
    const isFinal = state.currentRoundIndex >= TOTAL_ROUNDS;

    elements.roundCurrent.textContent = isFinal
        ? t('round.final')
        : t('round.current', { n: roundInfo.round });
    if (isFinal) {
        // 最终轮进入交换阶段，不再需要“开启 N 个箱子”的提示与“已开 x/y”进度
        elements.roundTarget.hidden = true;
        elements.roundProgress.hidden = true;
    } else {
        elements.roundTarget.hidden = false;
        elements.roundProgress.hidden = false;
        elements.roundTarget.textContent = t('round.toOpen', { n: roundInfo.boxesToOpen });
    }
    // 进度：使用 innerHTML 保留数字加粗样式（round.progress 内含 <b> 标签）
    elements.roundProgress.innerHTML = t('round.progress', {
        opened: state.openedThisRound,
        total: state.boxesToOpenThisRound
    });
}

/**
 * 显示银行家报价弹窗
 * @param {number} offer - 报价金额
 * @param {boolean} isBait - 是否为诱饵报价
 */
async function showBankerOffer(offer, isBait = false) {
    const state = StateManager.getState();
    const expectedValue = StateManager.calculateExpectedValue();
    const commentary = getOfferCommentary(offer, expectedValue, isBait);
    // 捕获代次：await 铃声音效期间若重开，后续评语/还价 UI 不得写入新局
    const epoch = currentUIEpoch();

    // 更新金额显示（带动画）
    elements.bankerOfferAmount.textContent = formatCurrency(offer);
    elements.bankerOfferAmount.classList.add('banker-modal__amount--animating');

    // 同步展示“你的箱子期望值”并附白话解释，让普通玩家看懂这是什么
    if (elements.bankerExpectedValue) {
        elements.bankerExpectedValue.textContent = formatCurrency(expectedValue);
    }

    // 记录当前报价上下文，供语言切换时在不重建弹窗的前提下刷新动态文案
    lastBankerOfferContext = { offer, isBait };

    // 显示弹窗（动画加在真正居中的内容层上）
    elements.bankerModal.hidden = false;
    elements.bankerModalContent.classList.add('modal-enter');

    // 遮罩显隐统一由“当前打开的弹窗”裁决，杜绝无背景弹窗/遮罩提前消失
    syncBackdrop();

    // 电话铃声动画：仅作装饰，不再阻塞流程
    // （此前这里 await 1500ms，导致弹窗已经出现却迟迟不能决策）
    const phoneIcon = elements.bankerModal.querySelector('.banker-modal__phone');
    if (phoneIcon) {
        phoneIcon.classList.add('banker-modal__phone--ringing');
        const ringDuration = (typeof TIMING !== 'undefined' && TIMING.bankerRingDuration != null)
            ? TIMING.bankerRingDuration : 900;
        scheduleUI(() => phoneIcon.classList.remove('banker-modal__phone--ringing'), ringDuration);
    }

    // 播放铃声音效（可选）。showBankerOffer 经由 setTimeout 触发、已脱离用户手势，
    // 但此时音频上下文应已在之前的点击中进入 running；await 确保 resume 完成后再播放
    await playSound('ring');

    // await 期间若已重开，报价弹窗属于上一局：放弃后续 DOM 写入
    if (epoch !== currentUIEpoch()) return;

    // 显示银行家评语（此前只 console.log，玩家看不到；现在写入弹窗，见 bug #5）
    if (elements.bankerCommentary) {
        elements.bankerCommentary.textContent = commentary;
        elements.bankerCommentary.classList.remove('banker-modal__commentary--show');
        void elements.bankerCommentary.offsetWidth; // 触发重排以重放淡入动画
        elements.bankerCommentary.classList.add('banker-modal__commentary--show');
    }

    // 刷新"讨价还价"按钮与输入面板的可见状态（整局仅一次）
    updateHaggleUI();

}

/**
 * 隐藏银行家报价弹窗
 * @param {boolean} [keepBackdrop=false] 进入交换阶段时复用当前遮罩，
 *   避免遮罩先隐后显的闪烁；隐藏完成后仍由 syncBackdrop() 按实际弹窗状态裁决
 */
function hideBankerOffer(keepBackdrop) {
    elements.bankerModalContent.classList.add('modal-exit');
    elements.bankerModalContent.classList.remove('modal-enter');
    if (elements.bankerCommentary) elements.bankerCommentary.textContent = '';
    elements.bankerOfferAmount.classList.remove('banker-modal__amount--animating');
    lastBankerOfferContext = null;

    // 过渡期间：非复用场景先播放遮罩退场动画；复用场景保持遮罩不动
    if (!keepBackdrop) {
        elements.modalBackdrop.classList.add('modal-backdrop-exit');
        elements.modalBackdrop.classList.remove('modal-backdrop-enter');
    }

    scheduleUI(() => {
        elements.bankerModal.hidden = true;
        elements.bankerModalContent.classList.remove('modal-exit');
        // 唯一裁决点：按当前真正打开的弹窗决定遮罩去留。
        // 若交换弹窗紧接着出现（keepBackdrop 场景），遮罩保持显示且无闪烁；
        // 若没有任何弹窗，则遮罩确定隐藏，不会提前消失也不会残留。
        syncBackdrop();
    }, 250);
}

/**
 * 显示 Switch Case 交换弹窗
 */
function showSwitchCase() {
    const state = StateManager.getState();
    const playerCase = StateManager.getPlayerCase();
    const otherCase = StateManager.getOtherCase();

    elements.switchPlayerCaseNum.textContent = playerCase.number;
    elements.switchOtherCaseNum.textContent = otherCase.number;

    elements.switchModal.hidden = false;
    elements.switchModalContent.classList.add('modal-enter');

    // 遮罩由统一裁决点管理：银行家弹窗退场过渡期间也能保证背景不中断
    syncBackdrop();
}

/**
 * 隐藏 Switch Case 弹窗
 */
function hideSwitchCase() {
    elements.switchModalContent.classList.add('modal-exit');
    elements.switchModalContent.classList.remove('modal-enter');

    // 遮罩退场动画（最终是否隐藏由 250ms 后的 syncBackdrop 裁决）
    elements.modalBackdrop.classList.add('modal-backdrop-exit');
    elements.modalBackdrop.classList.remove('modal-backdrop-enter');

    scheduleUI(() => {
        elements.switchModal.hidden = true;
        elements.switchModalContent.classList.remove('modal-exit');
        syncBackdrop();
    }, 250);
}

/**
 * 结算弹窗揭示状态
 * - resultRevealed：本局结算是否已完成揭示（摘要/详情/按钮均已可见）
 * - lastBankerOfferContext：当前报价弹窗的上下文，语言切换时用于原地刷新动态文案
 */
let resultRevealed = false;
let lastBankerOfferContext = null;

/**
 * 施加结算揭示动画。
 * @param {boolean} animate true=首次揭示，播放依次出现的动画；
 *   false=已揭示后的重建（语言切换），直接定格在可见终态，按钮不得回退隐藏
 */
function applyResultReveal(animate) {
    if (animate) {
        // 首次揭示：延迟一帧后加类，确保弹窗入场与揭示动画衔接
        scheduleUI(() => {
            elements.resultSummary.classList.add('result-modal__summary--reveal');
            elements.resultDetails.classList.add('result-modal__details--reveal');
            elements.btnRestart.classList.add('btn--restart--reveal');
            resultRevealed = true;
        }, 100);
    } else {
        // 已揭示状态下重建（语言切换）：直接保持终态，按钮始终可见
        elements.resultSummary.classList.add('result-modal__summary--reveal');
        elements.resultDetails.classList.add('result-modal__details--reveal');
        elements.btnRestart.classList.add('btn--restart--reveal');
        resultRevealed = true;
    }
}

/**
 * 显示游戏结果弹窗
 *
 * 幂等设计：语言切换时 applyI18n() 会再次调用本函数重建文案。
 * - 首次展示：播放完整揭示动画（摘要 → 详情 → “再来一局”按钮依次出现）；
 * - 已揭示后的重入（语言切换）：保持已揭示状态，按钮始终可见，不回退到隐藏态，
 *   也不依赖可能被重开作废的 setTimeout 来补类（修复语言切换后揭示动画/按钮丢失）。
 */
function showResult() {
    const wasAlreadyRevealed = resultRevealed;
    const summary = StateManager.getResultSummary();

    // 构建结果摘要
    let summaryHTML = '';
    let detailsHTML = '';

    // 给普通玩家看的“期望值”说明（白话解释 + 数值）
    const evLine = `
        <p class="result-ev">
            <span class="result-ev__label">${t('result.ev.label')}</span>
            <span class="result-ev__value">${formatCurrency(summary.expectedValue)}</span>
        </p>
        <p class="result-ev__hint">${t('ev.explainer')}</p>
    `;

    if (summary.isDeal) {
        // 还价被银行家接受时，结算标签应为“银行家接受了报价”而非“你接受了报价”
        const dealLabelKey = summary.decision === 'banker-accepted'
            ? 'result.bankerAccepted.label'
            : 'result.deal.label';
        summaryHTML = `
            <div class="result-deal">
                <span class="result-label">${t(dealLabelKey)}</span>
                <span class="result-amount highlight">${formatCurrency(summary.finalWinnings)}</span>
            </div>`;
        detailsHTML = `
            <p>${t('result.playerCaseWas')}<span class="highlight">${formatCurrency(summary.playerCaseValue)}</span></p>
            ${evLine}
            <p>${summary.beatExpected ? t('result.beat') : t('result.below')}</p>
        `;
    } else if (summary.decision === 'keep') {
        summaryHTML = `
            <div class="result-keep">
                <span class="result-label">${t('result.keep.label')}</span>
                <span class="result-amount highlight">${formatCurrency(summary.finalWinnings)}</span>
            </div>`;
        detailsHTML = `
            <p>${t('result.otherWas')}<span class="highlight">${formatCurrency(summary.otherCaseValue)}</span></p>
            ${evLine}
            <p>${summary.beatExpected ? t('result.beat') : t('result.below')}</p>
        `;
    } else if (summary.decision === 'switch') {
        summaryHTML = `
            <div class="result-switch">
                <span class="result-label">${t('result.switch.label')}</span>
                <span class="result-amount highlight">${formatCurrency(summary.finalWinnings)}</span>
            </div>`;
        detailsHTML = `
            <p>${t('result.origWas')}<span class="highlight">${formatCurrency(summary.otherCaseValue)}</span></p>
            ${evLine}
            <p>${summary.beatExpected ? t('result.beat') : t('result.below')}</p>
        `;
    }

    elements.resultSummary.innerHTML = summaryHTML;
    elements.resultDetails.innerHTML = detailsHTML;

    // innerHTML 重建会清掉旧节点上的揭示类：按当前揭示状态决定重放动画还是定格终态
    if (wasAlreadyRevealed) {
        elements.resultSummary.classList.add('result-modal__summary--reveal');
        elements.resultDetails.classList.add('result-modal__details--reveal');
        elements.btnRestart.classList.add('btn--restart--reveal');
    }

    elements.resultModal.hidden = false;
    elements.resultModalContent.classList.add('modal-enter');

    // 遮罩显隐统一裁决，杜绝无背景弹窗
    syncBackdrop();

    // 结算音效仅在首次揭示时播放，语言切换重建不重复响铃
    if (!wasAlreadyRevealed) {
        // showResult 本身在 setTimeout 中调用（脱离手势），但音频上下文此前已 running，playSound 会先 await resume
        playSound(summary.beatExpected ? 'win' : 'lose');
    }

    // 首次揭示走动画；已揭示后的重入直接保持可见终态
    applyResultReveal(!wasAlreadyRevealed);

    // 揭示玩家箱子实际金额（若流程中尚未以翻转动画打开，则在此兜底揭示）
    if (!elements.playerCaseBox.classList.contains('case--opened')) {
        revealPlayerCaseValue(summary.playerCaseValue);
    }
}

/**
 * 隐藏结果弹窗
 */
function hideResult() {
    elements.resultModalContent.classList.add('modal-exit');
    elements.resultModalContent.classList.remove('modal-enter');
    elements.resultSummary.classList.remove('result-modal__summary--reveal');
    elements.resultDetails.classList.remove('result-modal__details--reveal');
    elements.btnRestart.classList.remove('btn--restart--reveal');
    resultRevealed = false;

    // 遮罩退场动画（最终隐藏由延时后的 syncBackdrop 统一裁决）
    elements.modalBackdrop.classList.add('modal-backdrop-exit');
    elements.modalBackdrop.classList.remove('modal-backdrop-enter');

    scheduleUI(() => {
        elements.resultModal.hidden = true;
        elements.resultModalContent.classList.remove('modal-exit');
        syncBackdrop();
    }, 250);
}

/**
 * 揭示玩家箱子中的实际金额
 * @param {number} value
 */
function revealPlayerCaseValue(value) {
    elements.playerCaseBox.innerHTML = `
        <span class="player-case__value">${formatCurrency(value)}</span>
    `;
    elements.playerCaseBox.classList.add('case--opened', `case--${getValueClass(value)}`);
}

/**
 * 打开（翻转揭示）玩家自己的箱子，展示其中真实金额。
 * 用于：接受银行家报价(DEAL)后、保留/交换箱子后等"揭晓"场景，
 * 作为游戏结束前的戏剧性后续。
 * @param {number} value - 箱子真实金额
 * @returns {Promise} 动画完成 Promise
 */
function animatePlayerCaseOpen(value) {
    return new Promise(resolve => {
        const box = elements.playerCaseBox;
        if (!box) { resolve(); return; }

        // 捕获对局代次：翻转期间重开则放弃收尾，绝不在新局玩家箱上残留金额/配色类
        const epoch = currentUIEpoch();
        const num = StateManager.getPlayerCase().number;
        const valueClass = getValueClass(value);

        // 重置为"正面朝前、仅显示编号"的未开启状态（同时带好金额配色类，使背面颜色在翻转中即正确）
        box.classList.remove('case--opened', 'case--flipping', 'case--low', 'case--high');
        box.classList.add(`case--${valueClass}`);

        // 重建内部翻转结构（含 id 以便缓存引用 elements.playerCaseNumber 保持有效，修复 Bug #4）
        box.innerHTML = `
            <div class="case__inner">
                <div class="case__front">
                    <span class="case__number" id="player-case-number">${num}</span>
                </div>
                <div class="case__back case--${valueClass}">
                    <span class="case__value">${formatCurrency(value)}</span>
                </div>
            </div>`;
        // 重新缓存因 innerHTML 替换而失效的引用
        elements.playerCaseNumber = document.getElementById('player-case-number');

        // 强制重排，确保从正面(rotateY 0)开始过渡，从而触发翻转
        void box.offsetWidth;

        // 触发翻转动画
        box.classList.add('case--flipping');

        // 动画结束后定格为已开启状态（代次失效则只 resolve，不触碰新局箱子）
        setTimeout(() => {
            if (epoch !== currentUIEpoch()) { resolve(); return; }
            box.classList.remove('case--flipping');
            box.classList.add('case--opened', `case--${valueClass}`);
            resolve();
        }, 800); // 与 CSS 翻转过渡时长一致
    });
}

/**
 * 重置 UI 到初始状态
 *
 * 重开/初始化的统一收敛点：
 * 1. 先递增 UI 代次，使上一局所有延迟回调立即失效，不得再改动新局 DOM；
 * 2. 弹窗/遮罩/按钮/箱子全部复位到未开局外观，不残留上一局金额与配色类。
 */
function resetUI() {
    // 1) 失效上一局全部挂起的 UI 定时器（动画收尾、弹窗进退场、揭示延时等）
    invalidateUITimers();

    // 清理选箱飞行可能残留在 body 上的克隆体
    document.querySelectorAll('.case-fly').forEach(el => el.remove());

    // 重新渲染金额面板
    renderMoneyPanels();

    // 重新渲染箱子网格
    renderCasesGrid();

    // 隐藏玩家箱子显示，并彻底复位为“未开启”外观：
    // 清空上一局翻转结构与金额，重建仅含编号占位的初始结构，移除全部配色/动画类
    elements.playerCaseDisplay.hidden = true;
    elements.playerCaseBox.classList.remove(
        'player-case__box--incoming',
        'player-case__box--arrived',
        'case--opened',
        'case--flipping',
        'case--low',
        'case--high'
    );
    elements.playerCaseBox.innerHTML = '<span class="player-case__number" id="player-case-number"></span>';
    elements.playerCaseNumber = document.getElementById('player-case-number');

    // 隐藏轮次信息
    elements.roundInfo.hidden = true;
    // roundTarget / roundProgress 在新一局会被 updateRoundInfo 按阶段重新设置 hidden，
    // 这里先复位为可见，避免上一局停在最终轮时把进度条隐藏、导致新一局进度不显示
    elements.roundTarget.hidden = false;
    elements.roundProgress.hidden = false;

    // 隐藏所有弹窗（含开发者选项弹窗），复位内容层动画类
    elements.bankerModal.hidden = true;
    elements.switchModal.hidden = true;
    elements.resultModal.hidden = true;
    if (elements.devModal) elements.devModal.hidden = true;
    if (elements.bankerModalContent) elements.bankerModalContent.classList.remove('modal-enter', 'modal-exit');
    if (elements.switchModalContent) elements.switchModalContent.classList.remove('modal-enter', 'modal-exit');
    if (elements.resultModalContent) elements.resultModalContent.classList.remove('modal-enter', 'modal-exit');
    if (elements.devModalContent) elements.devModalContent.classList.remove('modal-enter', 'modal-exit');
    if (elements.bankerCommentary) elements.bankerCommentary.textContent = '';
    if (elements.bankerModal && elements.bankerModal.querySelector('.banker-modal__phone')) {
        elements.bankerModal.querySelector('.banker-modal__phone')
            .classList.remove('banker-modal__phone--ringing');
    }

    // 复位结算揭示状态与揭示类
    resultRevealed = false;
    lastBankerOfferContext = null;
    elements.resultSummary.classList.remove('result-modal__summary--reveal');
    elements.resultDetails.classList.remove('result-modal__details--reveal');
    elements.btnRestart.classList.remove('btn--restart--reveal');

    // 弹窗按钮恢复可用：新局首次报价出现时即可决策，不带上一局的 disabled 残留
    setButtonDisabled('btn-deal', false);
    setButtonDisabled('btn-no-deal', false);
    setButtonDisabled('btn-keep', false);
    setButtonDisabled('btn-switch', false);

    // 遮罩复位并交由统一裁决点确认隐藏（此时已无任何弹窗打开）
    elements.modalBackdrop.classList.remove('modal-backdrop-enter', 'modal-backdrop-exit');
    syncBackdrop();

    // 显示指示横幅
    elements.instructionBanner.hidden = false;
    elements.instructionBanner.classList.remove('instruction-banner--leaving');

    // 清理可能的动画残留类
    elements.casesGrid.classList.remove('is-settling');
    elements.playerCaseDisplay.classList.remove('player-case-display--fade');

    // 修复: 重置还价 UI 状态（新游戏开始时复位，避免上一局已用还价导致按钮残留隐藏）
    updateHaggleUI();
}

/**
 * 更新主题切换按钮图标
 * @param {string} theme - 'light' | 'dark'
 */
function updateThemeIcon(theme) {
    // 仅更新图标；data-theme 属性已在 GameController.applyTheme 中设置，避免重复
    // 保留此函数供向后兼容
}

// ========================================
// 音频上下文管理（解决自动播放策略问题）
// ========================================
let audioContext = null;
let audioInitialized = false;

function getAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
}

function initAudioOnUserInteraction() {
    if (audioInitialized) return;
    audioInitialized = true;
    // 创建音频上下文（这会在用户首次交互时解锁）
    getAudioContext();
    // 如果上下文被暂停，恢复它
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    // 移除监听器
    document.removeEventListener('click', initAudioOnUserInteraction);
    document.removeEventListener('keydown', initAudioOnUserInteraction);
    document.removeEventListener('touchstart', initAudioOnUserInteraction);
}

// 监听首次用户交互以初始化音频
document.addEventListener('click', initAudioOnUserInteraction);
document.addEventListener('keydown', initAudioOnUserInteraction);
document.addEventListener('touchstart', initAudioOnUserInteraction);

/**
 * 简单音效播放（使用 Web Audio API 生成基础音调）
 * @param {string} type - 'ring' | 'open' | 'deal' | 'win' | 'lose'
 *
 * 修复说明（对应分析报告根因 1/3）：
 *  - 浏览器自动播放策略要求 AudioContext 必须在 running 状态才发声。resume() 是异步的，
 *    旧代码在 suspended 时调用 resume() 后立刻按"冻结的 currentTime"同步调度振荡器，
 *    事件会被浏览器静默丢弃。这里改为 `await ctx.resume()` 之后再调度。
 *  - 旧代码的 try/catch 完全吞掉异常，失败后无任何痕迹。这里改为打印 console.warn，
 *    并在上下文仍不可用/类型未知时显式返回，避免静默失败、便于排查。
 */
async function playSound(type) {
    try {
        const ctx = getAudioContext();
        // 关键修复：resume() 异步，必须先 await 再调度，否则 suspended 下会被冻结时钟丢弃事件
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }
        // 若恢复后仍未 running（例如被系统/浏览器策略禁止），放弃本次播放但给出警告
        if (ctx.state !== 'running') {
            console.warn('[audio] AudioContext 未能进入 running 状态，跳过音效:', type);
            return;
        }

        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.connect(gain);
        gain.connect(ctx.destination);

        switch (type) {
            case 'ring':
                oscillator.frequency.setValueAtTime(440, ctx.currentTime);
                oscillator.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1);
                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + 1);
                break;
            case 'open':
                oscillator.frequency.setValueAtTime(300, ctx.currentTime);
                oscillator.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.2);
                gain.gain.setValueAtTime(0.08, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + 0.3);
                break;
            case 'deal':
                oscillator.frequency.setValueAtTime(523, ctx.currentTime);
                oscillator.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
                oscillator.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + 0.6);
                break;
            // 新增：游戏结束时根据是否战胜期望值播放胜/负提示音（修复设计为 win/lose 但原本未实现）
            case 'win':
                oscillator.type = 'triangle';
                oscillator.frequency.setValueAtTime(523, ctx.currentTime);          // C5
                oscillator.frequency.setValueAtTime(659, ctx.currentTime + 0.12);   // E5
                oscillator.frequency.setValueAtTime(784, ctx.currentTime + 0.24);   // G5
                oscillator.frequency.setValueAtTime(1047, ctx.currentTime + 0.36);  // C6
                gain.gain.setValueAtTime(0.12, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.7);
                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + 0.7);
                break;
            case 'lose':
                oscillator.type = 'sawtooth';
                oscillator.frequency.setValueAtTime(392, ctx.currentTime);          // G4
                oscillator.frequency.exponentialRampToValueAtTime(196, ctx.currentTime + 0.5); // 下行到 G3
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + 0.6);
                break;
            default:
                console.warn('[audio] 未知音效类型:', type);
                return;
        }

        // 播放结束后释放节点，避免长期运行后节点堆积
        oscillator.onended = () => {
            try { oscillator.disconnect(); gain.disconnect(); } catch (e) { /* noop */ }
        };
    } catch (e) {
        // 修复根因 3：不再静默吞掉，至少打印警告，便于排查音频失效
        console.warn('[audio] playSound 失败:', type, e);
    }
}


// ========================================
// 开发者选项（彩蛋：连续点击标题 5 次解锁）
// ========================================

// 标题连续点击计数：两次点击间隔超过阈值即清零
let titleClickCount = 0;
let titleClickTimer = null;
const TITLE_CLICK_THRESHOLD = 5;      // 需连续点击的次数
const TITLE_CLICK_RESET_MS = 2000;    // 相邻两次点击的最大间隔（毫秒）

/** 处理标题栏连续点击：累计满 5 次即弹出开发者选项 */
function handleTitleClick() {
    titleClickCount++;
    if (titleClickTimer) clearTimeout(titleClickTimer);
    titleClickTimer = setTimeout(function () { titleClickCount = 0; }, TITLE_CLICK_RESET_MS);
    if (titleClickCount >= TITLE_CLICK_THRESHOLD) {
        titleClickCount = 0;
        if (titleClickTimer) clearTimeout(titleClickTimer);
        showDevOptions();
    }
}

/** 是否还有其它重要弹窗处于打开状态（避免关闭开发者选项时误关背景遮罩） */
function _anyOtherModalOpen() {
    return !elements.bankerModal.hidden ||
           !elements.switchModal.hidden ||
           !elements.resultModal.hidden;
}

/** 显示开发者选项弹窗 */
function showDevOptions() {
    if (elements.devResult) {
        elements.devResult.innerHTML = '';
        elements.devResult.hidden = true;
        elements.devResult.classList.remove('dev-modal__result--show');
    }
    elements.devModal.hidden = false;
    elements.devModalContent.classList.add('modal-enter');
    // 遮罩统一裁决：开发者弹窗打开期间背景必须存在
    syncBackdrop();
}

/** 隐藏开发者选项弹窗 */
function hideDevOptions() {
    elements.devModalContent.classList.add('modal-exit');
    elements.devModalContent.classList.remove('modal-enter');
    if (!_anyOtherModalOpen()) {
        elements.modalBackdrop.classList.add('modal-backdrop-exit');
        elements.modalBackdrop.classList.remove('modal-backdrop-enter');
    }
    scheduleUI(function () {
        elements.devModal.hidden = true;
        elements.devModalContent.classList.remove('modal-exit');
        // 按当前真正打开的弹窗决定遮罩去留（其它弹窗仍开着则保留背景）
        syncBackdrop();
    }, 250);
}

/** 在弹窗内渲染全部 26 个箱子的金额（玩家箱子高亮） */
function renderDevCaseList(state) {
    const result = elements.devResult;
    if (!result) return;
    result.hidden = false;

    const items = [];
    for (let num = 1; num <= 26; num++) {
        const value = state.caseAssignments.get(num);
        if (value == null) continue;
        const cls = getValueClass(value);
        const isPlayer = (state.playerCaseNumber === num);
        items.push(
            '<div class="dev-case-item dev-case-item--' + cls + (isPlayer ? ' dev-case-item--player' : '') + '">' +
                '<span class="dev-case-item__num">' + num + (isPlayer ? ' ★' : '') + '</span>' +
                '<span class="dev-case-item__value">' + formatCurrency(value) + '</span>' +
            '</div>'
        );
    }
    result.innerHTML = '<div class="dev-case-grid">' + items.join('') + '</div>';
    void result.offsetWidth;
    result.classList.add('dev-modal__result--show');
}

/** 一键查看所有箱子的金额 */
function devRevealAllCases() {
    const state = StateManager.getState();

    // 只在弹窗列表里汇总全部 26 个箱子的真实金额（玩家箱子高亮）。
    // 开发者查看是“只读”的：不改动棋盘，也不揭示侧栏「你的箱子」，
    // 否则关闭弹窗后金额会一直残留在箱子上，破坏游戏隐藏性。
    renderDevCaseList(state);
    if (elements.devResult) {
        const hint = document.createElement('p');
        hint.className = 'dev-modal__msg';
        hint.textContent = t('dev.allDone');
        elements.devResult.insertBefore(hint, elements.devResult.firstChild);
    }
}

/** 在弹窗内只渲染玩家自己的箱子（查看“我的箱子”时用，不列出全部） */
function renderDevPlayerCase(state) {
    const result = elements.devResult;
    if (!result) return;
    result.hidden = false;

    const num = state.playerCaseNumber;
    const value = state.playerCaseValue;
    const cls = getValueClass(value);
    const item =
        '<div class="dev-case-item dev-case-item--' + cls + ' dev-case-item--player">' +
            '<span class="dev-case-item__num">' + num + ' ★</span>' +
            '<span class="dev-case-item__value">' + formatCurrency(value) + '</span>' +
        '</div>';
    result.innerHTML = '<div class="dev-case-grid">' + item + '</div>';
    void result.offsetWidth;
    result.classList.add('dev-modal__result--show');
}

/** 查看自己箱子的金额（只显示自己的箱子，不显示全部） */
function devRevealPlayerCase() {
    const state = StateManager.getState();

    if (!state.playerCaseNumber || state.playerCaseValue == null) {
        if (elements.devResult) {
            elements.devResult.hidden = false;
            elements.devResult.innerHTML = '<p class="dev-modal__msg dev-modal__msg--warn">' + t('dev.noCase') + '</p>';
        }
        return;
    }

    const pv = state.playerCaseValue;

    // 开发者查看是“只读”的：只在弹窗里渲染“我的箱子”，
    // 不揭示侧栏「你的箱子」盒子，避免关闭弹窗后金额残留在箱子上。
    renderDevPlayerCase(state);
    if (elements.devResult) {
        const msg = document.createElement('p');
        msg.className = 'dev-modal__msg';
        msg.textContent = t('dev.mineResult', { num: state.playerCaseNumber, value: formatCurrency(pv) });
        elements.devResult.insertBefore(msg, elements.devResult.firstChild);
    }
}

/** 在弹窗内只渲染“尚未开启”的箱子（即还在局中、对玩家隐藏的金额）。
 *  已开箱的会被自动排除；玩家的箱子仍未开启，因此仍算“剩余”并带 ★ 高亮。 */
function renderDevRemainingList(state) {
    const result = elements.devResult;
    if (!result) return;
    result.hidden = false;

    const opened = state.openedCases; // 已开箱的编号集合
    const items = [];
    for (let num = 1; num <= 26; num++) {
        if (opened.has(num)) continue; // 已开箱：跳过
        const value = state.caseAssignments.get(num);
        if (value == null) continue;
        const cls = getValueClass(value);
        const isPlayer = (state.playerCaseNumber === num);
        items.push(
            '<div class="dev-case-item dev-case-item--' + cls + (isPlayer ? ' dev-case-item--player' : '') + '">' +
                '<span class="dev-case-item__num">' + num + (isPlayer ? ' ★' : '') + '</span>' +
                '<span class="dev-case-item__value">' + formatCurrency(value) + '</span>' +
            '</div>'
        );
    }
    result.innerHTML = '<div class="dev-case-grid">' + items.join('') + '</div>';
    void result.offsetWidth;
    result.classList.add('dev-modal__result--show');
}

/** 查看“剩余”（尚未开启）的所有箱子金额 */
function devRevealRemainingCases() {
    const state = StateManager.getState();

    // 开发者查看是“只读”的：只在弹窗里汇总剩余的箱子金额，不改动棋盘，
    // 也不揭示侧栏「你的箱子」，避免关闭弹窗后金额残留在箱子上、破坏隐藏性。
    renderDevRemainingList(state);
    if (elements.devResult) {
        const remainingCount = 26 - state.openedCases.size;
        const hint = document.createElement('p');
        hint.className = 'dev-modal__msg';
        hint.textContent = t('dev.remainingDone', { count: remainingCount });
        elements.devResult.insertBefore(hint, elements.devResult.firstChild);
    }
}

/**
 * 绑定全局事件监听器
 * @param {object} handlers - 事件处理函数对象
 */
function bindEvents(handlers) {
    // 确保元素已缓存
    ensureElementsCached();

    // 防御性检查
    if (!elements.casesGrid || !elements.themeToggle) {
        console.error('[UI] 关键 DOM 元素未找到，事件绑定失败');
        return;
    }

    // 箱子点击事件（事件委托）
    elements.casesGrid.addEventListener('click', (e) => {
        const caseEl = e.target.closest('.case');
        if (!caseEl) return;
        const caseNumber = parseInt(caseEl.dataset.number, 10);
        handlers.onCaseClick(caseNumber);
    });

    // 箱子键盘事件（无障碍支持）
    elements.casesGrid.addEventListener('keydown', (e) => {
        const caseEl = e.target.closest('.case');
        if (!caseEl) return;

        const caseNumber = parseInt(caseEl.dataset.number, 10);

        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handlers.onCaseClick(caseNumber);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' ||
                   e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // 方向键导航
            e.preventDefault();
            navigateCases(caseEl, e.key);
        }
    });

    // 方向键导航函数
    function navigateCases(currentCase, direction) {
        const allCases = Array.from(elements.casesGrid.querySelectorAll('.case:not(.case--opened):not(.case--placeholder):not([disabled])'));
        if (allCases.indexOf(currentCase) === -1) return;

        // 列数随响应式布局变化（桌面 13 列、平板/手机 7 列），基于容器宽度计算避免 repeat() 语法导致解析失败
        const getGridCols = () => {
            const width = elements.casesGrid.offsetWidth;
            if (width < 600) return 7;
            if (width < 900) return 13;
            return 13;
        };
        const cols = getGridCols();
        const rows = Math.ceil(26 / cols);
        const playerCaseNumber = StateManager.getState().playerCaseNumber;
        // 玩家箱占位格所在视觉索引；无占位（选箱阶段）时为 -1
        const placeholderCell = playerCaseNumber ? playerCaseNumber - 1 : -1;

        // 26 格网格中第 N 个箱子固定落在第 N-1 格；玩家箱占位只占其中一格，
        // 不影响其余箱子 (编号-1) 的行列映射（修复 BUG-E：此前按焦点列表下标 ±列数，
        // 在占位格处发生 1 格列偏移，导致上下/左右导航落点错位）。
        let vi = currentCase - 1;
        let row = Math.floor(vi / cols);
        let col = vi % cols;

        if (direction === 'ArrowRight') col++;
        else if (direction === 'ArrowLeft') col--;
        else if (direction === 'ArrowDown') row++;
        else if (direction === 'ArrowUp') row--;

        // 越界则忽略（不换行）
        if (col < 0 || col >= cols || row < 0 || row >= rows) return;
        let nvi = row * cols + col;
        if (nvi < 0 || nvi > 25) return;

        // 落点恰为玩家箱占位格时，沿同方向再跳一格
        if (nvi === placeholderCell) {
            if (direction === 'ArrowRight' && col + 1 < cols) nvi = row * cols + (col + 1);
            else if (direction === 'ArrowLeft' && col - 1 >= 0) nvi = row * cols + (col - 1);
            else if (direction === 'ArrowDown' && row + 1 < rows) nvi = (row + 1) * cols + col;
            else if (direction === 'ArrowUp' && row - 1 >= 0) nvi = (row - 1) * cols + col;
            else return;
        }
        if (nvi < 0 || nvi > 25) return;

        const targetCase = nvi + 1;
        const targetEl = allCases.find(el => parseInt(el.dataset.number, 10) === targetCase);
        if (targetEl) targetEl.focus();
    }

    // Deal / No Deal 按钮
    elements.btnDeal.addEventListener('click', () => handlers.onDeal());
    elements.btnNoDeal.addEventListener('click', () => handlers.onNoDeal());

    // haggle events
    if (elements.btnHaggle) {
        elements.btnHaggle.addEventListener('click', () => { if (handlers.onHaggle) handlers.onHaggle(); });
    }
    if (elements.btnHaggleSubmit) {
        elements.btnHaggleSubmit.addEventListener('click', () => { if (handlers.onHaggleSubmit) handlers.onHaggleSubmit(); });
    }
    if (elements.btnHaggleCancel) {
        elements.btnHaggleCancel.addEventListener('click', () => { if (handlers.onHaggleCancel) handlers.onHaggleCancel(); });
    }
    if (elements.bankerHagglePanel) {
        elements.bankerHagglePanel.querySelectorAll('[data-add]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const add = parseFloat(btn.getAttribute('data-add'));
                if (isNaN(add)) return;
                const base = StateManager.getState().currentOffer;
                if (elements.bankerHaggleInput) {
                    elements.bankerHaggleInput.value = Math.round(base * (1 + add));
                }
            });
        });
    }

    // Switch Case 按钮
    elements.btnKeep.addEventListener('click', () => handlers.onKeep());
    elements.btnSwitch.addEventListener('click', () => handlers.onSwitch());

    // 重新开始按钮
    elements.btnRestart.addEventListener('click', () => handlers.onRestart());

    // 开发者选项（彩蛋）：连续点击标题 5 次解锁
    if (elements.gameTitle) {
        elements.gameTitle.addEventListener('click', handleTitleClick);
    }
    if (elements.btnDevAll) {
        elements.btnDevAll.addEventListener('click', () => devRevealAllCases());
    }
    if (elements.btnDevRemaining) {
        elements.btnDevRemaining.addEventListener('click', () => devRevealRemainingCases());
    }
    if (elements.btnDevMine) {
        elements.btnDevMine.addEventListener('click', () => devRevealPlayerCase());
    }
    if (elements.btnDevClose) {
        elements.btnDevClose.addEventListener('click', () => hideDevOptions());
    }

    // 主题切换：点击按钮展开/收起菜单
    if (elements.themeToggle) {
        elements.themeToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (handlers.onThemeToggle) handlers.onThemeToggle();
        });
    }
    // 主题菜单项选择（浅色 / 深色 / 跟随系统）
    if (elements.themeMenu) {
        elements.themeMenu.querySelectorAll('[data-theme-value]').forEach((li) => {
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                if (handlers.onThemeSelect) handlers.onThemeSelect(li.getAttribute('data-theme-value'));
            });
        });
    }
    // 语言切换：点击按钮展开/收起菜单
    if (elements.langToggle) {
        elements.langToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (handlers.onLangToggle) handlers.onLangToggle();
        });
    }
    // 语言菜单项选择（中文 / English / 跟随系统）
    if (elements.langMenu) {
        elements.langMenu.querySelectorAll('[data-lang-value]').forEach((li) => {
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                if (handlers.onLangSelect) handlers.onLangSelect(li.getAttribute('data-lang-value'));
            });
        });
    }
    // 点击空白处关闭菜单
    document.addEventListener('click', () => {
        if (handlers.onThemeClose) handlers.onThemeClose();
        if (handlers.onLangClose) handlers.onLangClose();
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
        // 若焦点在输入框（如"讨价还价"还价金额输入框）或内容可编辑区，
        // 不触发任何快捷键，避免输入字母 d/n 时误触 DEAL / NO DEAL
        const kt = e.target;
        if (kt && (kt.tagName === 'INPUT' || kt.tagName === 'TEXTAREA' || kt.isContentEditable)) {
            return;
        }
        // 还价面板打开时，D/N 快捷键同样失效，防止与输入还价冲突
        if (elements.bankerHagglePanel && !elements.bankerHagglePanel.hidden) {
            return;
        }

        // ESC 关闭弹窗
        if (e.key === 'Escape') {
            if (!elements.bankerModal.hidden) handlers.onNoDeal();
            if (!elements.switchModal.hidden) handlers.onKeep();
        }
        // D 键 = Deal
        if (e.key === 'd' || e.key === 'D') {
            if (!elements.bankerModal.hidden && !elements.btnDeal.disabled) handlers.onDeal();
        }
        // N 键 = No Deal
        if (e.key === 'n' || e.key === 'N') {
            if (!elements.bankerModal.hidden && !elements.btnNoDeal.disabled) handlers.onNoDeal();
        }
    });
}

/**
 * 设置按钮启用/禁用状态
 * @param {string} buttonId - 按钮 ID
 * @param {boolean} disabled - 是否禁用
 */
function setButtonDisabled(buttonId, disabled) {
    const btn = document.getElementById(buttonId);
    if (btn) btn.disabled = disabled;
}

// 不在模块加载时缓存元素，改为延迟缓存
function ensureElementsCached() {
    if (!elements.themeToggle) {
        cacheElements();
    }
}

// 导出确保元素已缓存的函数
function ensureElementsReady() {
    ensureElementsCached();
}

/**
 * 语言切换时原地刷新银行家报价弹窗的动态文案。
 * 不重建/不隐藏弹窗，也不触碰遮罩与按钮状态，保证弹窗、遮罩、按钮始终一致。
 */
function refreshBankerOfferI18n() {
    if (!elements.bankerModal || elements.bankerModal.hidden) return;
    const ctx = lastBankerOfferContext;
    if (ctx) {
        const expectedValue = StateManager.calculateExpectedValue();
        const commentary = getOfferCommentary(ctx.offer, expectedValue, ctx.isBait);
        if (elements.bankerCommentary) {
            elements.bankerCommentary.textContent = commentary;
            // 保持评语可见态（不重新播放淡入，避免语言切换时闪烁）
            elements.bankerCommentary.classList.add('banker-modal__commentary--show');
        }
        if (elements.bankerExpectedValue) {
            elements.bankerExpectedValue.textContent = formatCurrency(expectedValue);
        }
    }
    // 还价按钮/面板的可见性随当前局状态刷新，禁用态保持不变
    updateHaggleUI();
    // 重新应用当前按钮禁用态以外的状态后，确保按钮状态不被语言切换改变：
    // updateHaggleUI 只按 haggleUsed 处理还价按钮，DEAL/NO DEAL 不受影响
}

/**
 * 切换语言时刷新"动态"文案（静态文案由全局 applyStaticI18n() 负责）。
 * - 轮次信息（若可见）
 * - 银行家报价弹窗（若可见，原地刷新评语/期望值，不重建弹窗、不动遮罩与按钮）
 * - 交换弹窗（若可见，刷新两个箱子编号展示）
 * - 结算弹窗（若可见，按当前语言重建文本并保持已揭示状态与“再来一局”按钮可见）
 */
function applyI18n() {
    ensureElementsCached();
    if (elements.roundInfo && !elements.roundInfo.hidden) {
        updateRoundInfo();
    }
    if (elements.bankerModal && !elements.bankerModal.hidden) {
        refreshBankerOfferI18n();
    }
    if (elements.switchModal && !elements.switchModal.hidden) {
        const playerCase = StateManager.getPlayerCase();
        const otherCase = StateManager.getOtherCase();
        if (elements.switchPlayerCaseNum && playerCase.number != null) {
            elements.switchPlayerCaseNum.textContent = playerCase.number;
        }
        if (elements.switchOtherCaseNum && otherCase.number != null) {
            elements.switchOtherCaseNum.textContent = otherCase.number;
        }
    }
    if (elements.resultModal && !elements.resultModal.hidden) {
        // showResult 幂等：已揭示时重建文本并定格在可见终态，按钮不回退隐藏
        showResult();
    }
}

// ========================================
// 讨价还价（还价）相关 UI
// ========================================

// 根据是否已用过还价，刷新"讨价还价"按钮与输入面板的可见状态
function updateHaggleUI() {
    if (!elements.btnHaggle) return;
    const used = StateManager.getState().haggleUsed;
    // 每次展示报价时复位还价按钮的可见/可用状态：未使用 -> 显示且可用；已使用 -> 隐藏。
    // 这样即便上一局在 DEAL/NO DEAL 时已被禁用（修复 BUG-A），新一局/新一轮也会重新可用。
    elements.btnHaggle.hidden = used;
    elements.btnHaggle.disabled = used;
    if (elements.bankerHagglePanel) elements.bankerHagglePanel.hidden = true;
    if (elements.bankerHaggleResult) {
        elements.bankerHaggleResult.hidden = true;
        elements.bankerHaggleResult.textContent = '';
        elements.bankerHaggleResult.classList.remove('banker-modal__haggle-result--accepted', 'banker-modal__haggle-result--rejected');
    }
    if (!used && elements.bankerHaggleInput) {
        const offer = StateManager.getState().currentOffer;
        // 修复: 保底至少 1，输入框有 min="1"，防止报价 < $1 时取整为 0 导致无效值
        elements.bankerHaggleInput.value = Math.max(1, Math.round(offer));
    }
}

// 展开还价输入面板
function showHagglePanel() {
    if (elements.bankerHagglePanel) elements.bankerHagglePanel.hidden = false;
    if (elements.bankerHaggleInput) elements.bankerHaggleInput.focus();
}

// 收起还价输入面板
function hideHagglePanel() {
    if (elements.bankerHagglePanel) elements.bankerHagglePanel.hidden = true;
}

// 读取玩家输入的还价金额（字符串）
function getHaggleInputValue() {
    return elements.bankerHaggleInput ? elements.bankerHaggleInput.value : '';
}

// 更新报价金额显示（还价被接受时刷新）
function setOfferDisplay(offer) {
    if (!elements.bankerOfferAmount) return;
    elements.bankerOfferAmount.textContent = formatCurrency(offer);
    elements.bankerOfferAmount.classList.add('banker-modal__amount--animating');
    // 代次保护：重开后不再操作新局报价元素
    scheduleUI(() => {
        if (elements.bankerOfferAmount) elements.bankerOfferAmount.classList.remove('banker-modal__amount--animating');
    }, 600);
}

// 显示银行家对还价的回应
function showHaggleResult(message, accepted) {
    if (!elements.bankerHaggleResult) return;
    elements.bankerHaggleResult.hidden = false;
    elements.bankerHaggleResult.textContent = message;
    elements.bankerHaggleResult.classList.toggle('banker-modal__haggle-result--accepted', !!accepted);
    elements.bankerHaggleResult.classList.toggle('banker-modal__haggle-result--rejected', !accepted);
}

const UI = {
    renderMoneyPanels,
    highlightMoneyValue,
    renderCasesGrid,
    animateCaseOpen,
    preparePlayerCaseDisplay,
    animatePlayerCaseSelection,
    updateRoundInfo,
    showBankerOffer,
    hideBankerOffer,
    showSwitchCase,
    hideSwitchCase,
    showResult,
    hideResult,
    revealPlayerCaseValue,
    animatePlayerCaseOpen,
    resetUI,
    applyI18n,
    updateThemeIcon,
    bindEvents,
    setButtonDisabled,
    playSound,
    updateHaggleUI,
    showHagglePanel,
    hideHagglePanel,
    getHaggleInputValue,
    setOfferDisplay,
    showHaggleResult,
    showDevOptions,
    hideDevOptions,
    handleTitleClick,
    devRevealAllCases,
    devRevealRemainingCases,
    devRevealPlayerCase,
    // 状态收敛辅助（供 window.DealOrNoDeal 控制台验收使用）
    syncBackdrop,
    isAnyModalOpen,
    refreshBankerOfferI18n,
    scheduleUI,
    invalidateUITimers,
    currentUIEpoch
};
