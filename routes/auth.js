const express = require('express');
const fetch = require('node-fetch');
const AuthenticationHandler = require('../auth/AuthenticationHandler');

const router = express.Router();
const authHandler = new AuthenticationHandler();

/**
 * Discord OAuth Routes
 */

// Discord OAuth initiation
router.get('/discord', (req, res) => {
    res.render('discordcallback', {
        session: req.session
    });
});

// Discord OAuth token handler (existing route, updated)
router.post('/receive-token', async (req, res) => {
    const { accessToken } = req.body;

    if (!accessToken) {
        return res.status(400).send({
            status: 'error',
            message: 'Access token is required'
        });
    }

    try {
        // Fetch user details from Discord API
        const discordResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!discordResponse.ok) {
            console.error(`Failed to fetch Discord user: ${discordResponse.statusText}`);
            return res.status(discordResponse.status).send({
                status: 'error',
                message: `Discord API error: ${discordResponse.statusText}`
            });
        }

        const discordUser = await discordResponse.json();

        if (!discordUser.username || !discordUser.id) {
            console.error(`Invalid Discord user data received: ${JSON.stringify(discordUser)}`);
            return res.status(400).send({
                status: 'error',
                message: 'Invalid Discord user data'
            });
        }

        // Use new authentication handler
        const authResult = await authHandler.handleProviderAuth('discord', discordUser, req);

        if (authResult.status === 'conflict') {
            return res.status(409).send(authResult);
        }

        if (authResult.status === 'error') {
            return res.status(500).send(authResult);
        }

        // Success response
        res.send({
            status: 'success',
            message: authResult.message,
            account_id: authResult.accountId,
            username: authResult.username,
            isNewUser: authResult.isNewUser || false
        });

    } catch (error) {
        console.error('Discord authentication error:', error);
        res.status(500).send({
            status: 'error',
            message: 'Internal server error during authentication'
        });
    }
});

/**
 * Google OAuth Routes
 */

// Google OAuth initiation
router.get('/google', (req, res) => {
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${process.env.GOOGLE_OAUTH_CLIENT_ID}&` +
        `redirect_uri=${encodeURIComponent(process.env.GOOGLE_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`)}&` +
        `response_type=code&` +
        `scope=openid email profile&` +
        `access_type=offline&` +
        `prompt=consent`;
    
    res.redirect(googleAuthUrl);
});

// Google OAuth callback
router.get('/google/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        console.error('Google OAuth error:', error);
        return res.redirect('/login?error=oauth_error');
    }

    if (!code) {
        return res.redirect('/login?error=missing_code');
    }

    try {
        // Exchange code for access token
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
                client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.text();
            console.error('Google token exchange failed:', errorData);
            return res.redirect('/login?error=token_exchange_failed');
        }

        const tokenData = await tokenResponse.json();

        // Fetch user profile
        const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`
            }
        });

        if (!profileResponse.ok) {
            console.error('Failed to fetch Google user profile');
            return res.redirect('/login?error=profile_fetch_failed');
        }

        const googleUser = await profileResponse.json();

        if (!googleUser.id || !googleUser.email) {
            console.error('Invalid Google user data:', googleUser);
            return res.redirect('/login?error=invalid_user_data');
        }

        // Use new authentication handler
        const authResult = await authHandler.handleProviderAuth('google', googleUser, req);

        if (authResult.status === 'conflict') {
            // Redirect to conflict resolution page
            return res.redirect('/auth/resolve-conflict');
        }

        if (authResult.status === 'error') {
            console.error('Google authentication error:', authResult.error);
            return res.redirect('/login?error=auth_failed');
        }

        // Success - redirect to home page
        res.redirect('/?login=success');

    } catch (error) {
        console.error('Google OAuth callback error:', error);
        res.redirect('/login?error=internal_error');
    }
});

/**
 * Conflict Resolution Routes
 */

// Display conflict resolution page
router.get('/resolve-conflict', (req, res) => {
    const conflictData = req.session.authConflict;
    
    if (!conflictData) {
        return res.redirect('/login?error=no_conflict_data');
    }

    // Check if conflict data is expired
    const conflictAge = Date.now() - conflictData.timestamp;
    if (conflictAge > 30 * 60 * 1000) { // 30 minutes
        delete req.session.authConflict;
        return res.redirect('/login?error=conflict_expired');
    }

    res.render('account-conflict', {
        session: req.session,
        conflictData: conflictData,
        currentAccount: req.session.loggedIn ? { accountId: req.session.accountId } : null,
        existingAccount: conflictData.conflictingAccount
    });
});

// Handle conflict resolution
router.post('/resolve-conflict', async (req, res) => {
    const { resolution } = req.body;

    if (!resolution || !['keep-current', 'switch-existing', 'merge-accounts'].includes(resolution)) {
        return res.status(400).send({
            status: 'error',
            message: 'Invalid resolution choice'
        });
    }

    try {
        const result = await authHandler.resolveAccountConflict(req, resolution);

        if (result.status === 'success') {
            res.send({
                status: 'success',
                message: result.message,
                redirectUrl: '/?conflict=resolved'
            });
        } else {
            res.status(500).send(result);
        }

    } catch (error) {
        console.error('Conflict resolution error:', error);
        res.status(500).send({
            status: 'error',
            message: error.message || 'Failed to resolve conflict'
        });
    }
});

/**
 * Utility Routes
 */

// Logout route
router.post('/logout', (req, res) => {
    authHandler.logout(req);
    res.send({
        status: 'success',
        message: 'Logged out successfully'
    });
});

// Get current user info
router.get('/user', async (req, res) => {
    try {
        const user = await authHandler.getUserBySession(req);
        
        if (!user) {
            return res.status(401).send({
                status: 'error',
                message: 'Not authenticated'
            });
        }

        res.send({
            status: 'success',
            user: {
                accountId: user.accountId,
                username: user.username,
                primaryEmail: user.primaryEmail,
                profileImg: user.profileImg,
                oauthProviders: user.oauthProviders.map(p => ({
                    provider: p.provider,
                    displayName: p.displayName,
                    linkedAt: p.linkedAt,
                    lastLogin: p.lastLogin
                }))
            }
        });

    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).send({
            status: 'error',
            message: 'Failed to get user information'
        });
    }
});

// Link additional OAuth provider
router.post('/link/:provider', async (req, res) => {
    const { provider } = req.params;
    
    if (!authHandler.supportedProviders.includes(provider)) {
        return res.status(400).send({
            status: 'error',
            message: `Unsupported provider: ${provider}`
        });
    }

    // Store linking intent in session
    req.session.linkingProvider = provider;
    req.session.linkingTimestamp = Date.now();

    // Redirect to OAuth provider
    res.redirect(`/auth/${provider}`);
});

// Unlink OAuth provider
router.post('/unlink/:provider', async (req, res) => {
    const { provider } = req.params;

    try {
        const user = await authHandler.getUserBySession(req);
        
        if (!user) {
            return res.status(401).send({
                status: 'error',
                message: 'Not authenticated'
            });
        }

        // Check if user has multiple providers (prevent account lockout)
        if (user.oauthProviders.length <= 1) {
            return res.status(400).send({
                status: 'error',
                message: 'Cannot unlink the only authentication method'
            });
        }

        // Remove OAuth provider
        user.removeOAuthProvider(provider);
        await user.save();

        res.send({
            status: 'success',
            message: `${provider} account unlinked successfully`
        });

    } catch (error) {
        console.error('Unlink provider error:', error);
        res.status(500).send({
            status: 'error',
            message: 'Failed to unlink provider'
        });
    }
});

module.exports = router;