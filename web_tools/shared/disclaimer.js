// Interactive Experimental Disclaimer Modal Logic
(function() {
    const STORAGE_KEY = 'laser_suite_disclaimer_dismissed';
    const SESSION_NAV_KEY = 'laser_navigated_away';

    const isSubpage = window.location.pathname.includes('/web_tools/') || window.location.pathname.includes('\\web_tools\\');
    const isNavPage = !isSubpage;

    // Detect page reload/refresh
    let isReload = false;
    try {
        const navEntries = performance.getEntriesByType && performance.getEntriesByType('navigation');
        if (navEntries && navEntries.length > 0) {
            isReload = (navEntries[0].type === 'reload');
        } else if (window.performance && window.performance.navigation) {
            isReload = (window.performance.navigation.type === 1);
        }
    } catch (e) {}

    // On subpages, immediately record that the user has navigated away into tools
    if (isSubpage) {
        try {
            sessionStorage.setItem(SESSION_NAV_KEY, 'true');
        } catch (e) {}
    } else if (isReload) {
        // If the navigation portal was refreshed/reloaded, clear the navigation-away flag
        // so the warning displays again as requested
        try {
            sessionStorage.removeItem(SESSION_NAV_KEY);
        } catch (e) {}
    }

    // When clicking any link going into web_tools from the hub, set the session flag
    document.addEventListener('click', function(e) {
        const a = e.target.closest && e.target.closest('a');
        if (a && a.href && (a.href.includes('web_tools') || a.href.includes('/configurator') || a.href.includes('/gcode_visualizer') || a.href.includes('/simulator_3d'))) {
            try {
                sessionStorage.setItem(SESSION_NAV_KEY, 'true');
            } catch (err) {}
        }
    });

    function createModalHTML() {
        if (document.getElementById('laser_disclaimer_modal')) return;

        const overlay = document.createElement('div');
        overlay.id = 'laser_disclaimer_modal';
        overlay.className = 'disclaimer-overlay hidden';

        overlay.innerHTML = `
            <div class="disclaimer-modal">
                <div class="disclaimer-header">
                    <div class="disclaimer-title-group">
                        <span class="disclaimer-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="#f59e0b" style="vertical-align: middle;"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg></span>
                        <h3 class="disclaimer-title">IMPORTANT SAFETY & EXPERIMENTAL DISCLAIMER</h3>
                    </div>
                    <button class="disclaimer-close-btn" id="disclaimer_close_x" title="Close">×</button>
                </div>
                <div class="disclaimer-body">
                    <div class="disclaimer-alert-box">
                        <strong>100% EXPERIMENTAL PROJECT & USE AT YOUR OWN RISK:</strong><br>
                        This entire software suite, hardware integration, and laser-assisted 3D printing workflow are experimental research prototypes. Any operation performed with these tools is entirely at your own risk. High-power laser diodes present serious fire, permanent eye damage, and toxic fume hazards. Never leave equipment unattended.
                    </div>
                    <div class="disclaimer-list">
                        <div class="disclaimer-item">
                            <span class="disclaimer-item-icon">🐛</span>
                            <div class="disclaimer-item-text">
                                <strong>All Wall Smoothing Modes Can Contain Bugs:</strong> Every wall remelting feature is experimental. Specifically, <strong>Deep Mode</strong> and <strong>all Wobble modes (Deep Wobble & Voxel Wobble)</strong> still contain known bugs when processing complicated geometries, sharp corners, thin walls, and non-manifold shapes.
                            </div>
                        </div>
                        <div class="disclaimer-item">
                            <span class="disclaimer-item-icon">🔍</span>
                            <div class="disclaimer-item-text">
                                <strong>Mandatory Simulation Before Printing:</strong> Never send modified G-code directly to physical hardware without inspection. Always open the G-Code Visualizer or 3D Simulator to confirm that laser firing paths and nozzle trajectories are safe.
                            </div>
                        </div>
                    </div>
                </div>
                <div class="disclaimer-footer">
                    <label class="disclaimer-checkbox-label">
                        <input type="checkbox" id="disclaimer_dont_show_cb">
                        <span>I understand. Do not show this warning again.</span>
                    </label>
                    <button class="disclaimer-ack-btn" id="disclaimer_ack_btn">Acknowledge & Continue</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Bind events
        const closeX = document.getElementById('disclaimer_close_x');
        const ackBtn = document.getElementById('disclaimer_ack_btn');
        const dontShowCb = document.getElementById('disclaimer_dont_show_cb');

        function dismissModal() {
            if (dontShowCb.checked) {
                try {
                    localStorage.setItem(STORAGE_KEY, 'true');
                } catch (e) {}
            }
            overlay.classList.add('hidden');
        }

        closeX.addEventListener('click', dismissModal);
        ackBtn.addEventListener('click', dismissModal);
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                dismissModal();
            }
        });
    }

    window.showLaserDisclaimer = function(force) {
        let isDismissedPermanently = false;
        try {
            isDismissedPermanently = (localStorage.getItem(STORAGE_KEY) === 'true');
        } catch (e) {}

        if (force) {
            const el = document.getElementById('laser_disclaimer_modal');
            if (el) el.classList.remove('hidden');
            return;
        }

        // Automatic popup rules:
        // 1. Only show on the navigation webpage (index.html)
        if (!isNavPage) {
            return;
        }

        // 2. If user permanently dismissed with "Do not show again", do not show
        if (isDismissedPermanently) {
            return;
        }

        // 3. If navigated back from a subpage in this session, do not show
        let navigatedAway = false;
        try {
            navigatedAway = (sessionStorage.getItem(SESSION_NAV_KEY) === 'true');
        } catch (e) {}

        if (navigatedAway) {
            return;
        }

        // Otherwise show modal (fresh tab open or page refresh)
        const el = document.getElementById('laser_disclaimer_modal');
        if (el) {
            el.classList.remove('hidden');
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            createModalHTML();
            window.showLaserDisclaimer(false);
        });
    } else {
        createModalHTML();
        window.showLaserDisclaimer(false);
    }
})();
