const userProfileSchema = require('../schemas/userProfileSchemaNew');
const UsernameUtils = require('../utils/usernameUtils');

class AuthenticationHandler {
    constructor() {
        this.supportedProviders = ['discord', 'google'];
    }

    /**
     * Handle OAuth authentication for any supported provider
     * @param {string} provider - OAuth provider ('discord', 'google')
     * @param {Object} userData - User data from OAuth provider
     * @param {Object} req - Express request object
     * @returns {Object} Authentication result
     */
    async handleProviderAuth(provider, userData, req) {
        try {
            if (!this.supportedProviders.includes(provider)) {
                throw new Error(`Unsupported OAuth provider: ${provider}`);
            }

            // Validate required user data
            this.validateUserData(provider, userData);

            // Check for existing account with this provider
            const existingAccount = await userProfileSchema.findByOAuthProvider(provider, userData.id);

            if (existingAccount) {
                // User exists, update login info and create session
                return await this.handleExistingUser(existingAccount, provider, userData, req);
            } else {
                // PRIORITY: If user is already logged in, try to link this provider to their current account
                if (req.session.loggedIn && req.session.accountId) {
                    console.log(`User already logged in (accountId: ${req.session.accountId}), attempting to link ${provider} account`);
                    
                    // Check if the new provider conflicts with existing accounts
                    const conflictResult = await this.checkProviderConflicts(provider, userData);
                    
                    if (conflictResult.hasConflict && conflictResult.conflictingAccount.accountId !== req.session.accountId) {
                        // Conflict with a different account - require resolution
                        req.session.authConflict = {
                            provider,
                            userData,
                            conflictingAccount: conflictResult.conflictingAccount,
                            currentAccountId: req.session.accountId,
                            timestamp: Date.now()
                        };
                        
                        return {
                            status: 'conflict',
                            message: 'Account linking conflict detected - this provider is already linked to another account',
                            conflictData: conflictResult,
                            redirectUrl: '/auth/resolve-conflict'
                        };
                    }
                    
                    // No conflict or conflict with same account - link provider to current account
                    const linkResult = await this.linkProviderToAccount(req.session.accountId, provider, userData);
                    
                    // Set provider-specific session flag for newly linked provider
                    if (linkResult.status === 'success') {
                        if (provider === 'discord') {
                            req.session.discord = true;
                        } else if (provider === 'google') {
                            req.session.google = true;
                        }
                    }
                    
                    return linkResult;
                }

                // User not logged in - check for conflicts with other providers
                const conflictResult = await this.checkProviderConflicts(provider, userData);
                
                if (conflictResult.hasConflict) {
                    // Store conflict data in session for resolution
                    req.session.authConflict = {
                        provider,
                        userData,
                        conflictingAccount: conflictResult.conflictingAccount,
                        timestamp: Date.now()
                    };
                    
                    return {
                        status: 'conflict',
                        message: 'Account linking conflict detected',
                        conflictData: conflictResult,
                        redirectUrl: '/auth/resolve-conflict'
                    };
                }

                // Create new account
                return await this.createNewUser(provider, userData, req);
            }

        } catch (error) {
            console.error(`Authentication error for ${provider}:`, error);
            return {
                status: 'error',
                message: error.message || 'Authentication failed',
                error: error
            };
        }
    }

    /**
     * Validate user data from OAuth provider
     * @param {string} provider - OAuth provider
     * @param {Object} userData - User data to validate
     */
    validateUserData(provider, userData) {
        if (!userData.id) {
            throw new Error(`Missing user ID from ${provider}`);
        }

        if (provider === 'discord') {
            if (!userData.username) {
                throw new Error('Missing username from Discord');
            }
            if (!/^\d{17,19}$/.test(userData.id)) {
                throw new Error('Invalid Discord ID format');
            }
        } else if (provider === 'google') {
            if (!userData.email) {
                throw new Error('Missing email from Google');
            }
            if (!userData.name) {
                throw new Error('Missing name from Google');
            }
        }
    }

    /**
     * Handle authentication for existing user
     * @param {Object} existingAccount - Existing user account
     * @param {string} provider - OAuth provider
     * @param {Object} userData - User data from provider
     * @param {Object} req - Express request object
     */
    async handleExistingUser(existingAccount, provider, userData, req) {
        // Update OAuth provider data
        existingAccount.addOAuthProvider({
            provider,
            providerId: userData.id,
            email: userData.email || '',
            displayName: userData.name || userData.username || '',
            profilePicture: userData.avatar_url || userData.picture || ''
        });

        // Update last login
        existingAccount.updateLastLogin(provider);

        // Save changes
        await existingAccount.save();

        // Create session
        req.session.accountId = existingAccount.accountId;
        req.session.loggedIn = true;
        req.session.loginProvider = provider;
        
        // Initialize all session provider flags based on connected providers
        this.initializeSessionProviderFlags(req, existingAccount);
        
        // Ensure the current login provider flag is set
        if (provider === 'discord') {
            req.session.discord = true;
        } else if (provider === 'google') {
            req.session.google = true;
        }

        return {
            status: 'success',
            message: 'User logged in successfully',
            accountId: existingAccount.accountId,
            username: existingAccount.username,
            provider: provider
        };
    }

    /**
     * Check for conflicts with other OAuth providers
     * @param {string} provider - Current OAuth provider
     * @param {Object} userData - User data from provider
     * @returns {Object} Conflict check result
     */
    async checkProviderConflicts(provider, userData) {
        const conflicts = [];

        // Check email conflicts (for Google)
        if (provider === 'google' && userData.email) {
            const emailConflict = await userProfileSchema.findOne({
                $or: [
                    { primaryEmail: userData.email },
                    { "oauthProviders.email": userData.email }
                ]
            });

            if (emailConflict) {
                conflicts.push({
                    type: 'email',
                    value: userData.email,
                    conflictingAccount: emailConflict
                });
            }
        }

        // Check for existing accounts with different providers but same user
        // This is more complex and might require additional user input

        return {
            hasConflict: conflicts.length > 0,
            conflicts,
            conflictingAccount: conflicts.length > 0 ? conflicts[0].conflictingAccount : null
        };
    }

    /**
     * Create new user account
     * @param {string} provider - OAuth provider
     * @param {Object} userData - User data from provider
     * @param {Object} req - Express request object
     */
    async createNewUser(provider, userData, req) {
        // Generate clean username using shared utility
        let cleanUsername = UsernameUtils.generateCleanUsernameFromProvider(provider, userData);

        // Ensure username uniqueness using shared utility
        cleanUsername = await UsernameUtils.ensureUniqueUsername(cleanUsername);

        // Create new user profile
        const nextAccountId = await userProfileSchema.getNextAccountId();

        const newProfile = new userProfileSchema({
            accountId: nextAccountId,
            username: cleanUsername,
            primaryEmail: userData.email || '',
            timestamp: Date.now().toString(),
            createdAt: new Date(),
            lastLoginAt: new Date()
        });

        // Add OAuth provider
        newProfile.addOAuthProvider({
            provider,
            providerId: userData.id,
            email: userData.email || '',
            displayName: userData.name || userData.username || '',
            profilePicture: userData.avatar_url || userData.picture || ''
        });

        // Set profile image if available
        if (userData.avatar_url || userData.picture) {
            newProfile.profileImg = userData.avatar_url || userData.picture;
        }

        // Save new profile
        await newProfile.save();

        // Create session
        req.session.accountId = newProfile.accountId;
        req.session.loggedIn = true;
        req.session.loginProvider = provider;
        
        // Set provider-specific session flags
        if (provider === 'discord') {
            req.session.discord = true;
        } else if (provider === 'google') {
            req.session.google = true;
        }

        // Trigger sitemap regeneration for new user registration
        try {
            const sitemapTrigger = require('../utils/sitemap/sitemapTrigger');
            sitemapTrigger.onUserRegistered();
        } catch (error) {
            console.log('Error triggering sitemap regeneration for new user:', error);
            // Don't let sitemap errors affect the main functionality
        }

        return {
            status: 'success',
            message: 'New user account created',
            accountId: newProfile.accountId,
            username: newProfile.username,
            provider: provider,
            isNewUser: true
        };
    }


    /**
     * Resolve account linking conflict
     * @param {Object} req - Express request object
     * @param {string} resolution - User's choice ('keep-current', 'switch-existing', 'merge-accounts')
     * @returns {Object} Resolution result
     */
    async resolveAccountConflict(req, resolution) {
        const conflictData = req.session.authConflict;
        
        if (!conflictData) {
            throw new Error('No conflict data found in session');
        }

        // Check if conflict data is still valid (not expired)
        const conflictAge = Date.now() - conflictData.timestamp;
        if (conflictAge > 30 * 60 * 1000) { // 30 minutes
            throw new Error('Conflict resolution session expired');
        }

        const { provider, userData, conflictingAccount } = conflictData;

        try {
            let result;

            switch (resolution) {
                case 'keep-current':
                    // Keep current session, link new provider to existing account
                    result = await this.linkProviderToAccount(req.session.accountId, provider, userData);
                    break;

                case 'switch-existing':
                    // Switch to conflicting account, link new provider
                    result = await this.switchToExistingAccount(conflictingAccount, provider, userData, req);
                    break;

                case 'merge-accounts':
                    // Merge accounts (advanced feature)
                    result = await this.mergeAccounts(req.session.accountId, conflictingAccount.accountId, provider, userData);
                    break;

                default:
                    throw new Error(`Invalid resolution: ${resolution}`);
            }

            // Clear conflict data from session
            delete req.session.authConflict;

            return result;

        } catch (error) {
            console.error('Conflict resolution error:', error);
            throw error;
        }
    }

    /**
     * Link OAuth provider to existing account
     * @param {number} accountId - Target account ID
     * @param {string} provider - OAuth provider to link
     * @param {Object} userData - User data from provider
     */
    async linkProviderToAccount(accountId, provider, userData) {
        const account = await userProfileSchema.findOne({ accountId });
        
        if (!account) {
            throw new Error('Account not found');
        }

        // Check if provider is already linked to this account
        const existingProvider = account.oauthProviders && account.oauthProviders[provider];
        if (existingProvider && existingProvider.providerId === userData.id) {
            // Update existing provider data
            account.addOAuthProvider({
                provider,
                providerId: userData.id,
                email: userData.email || '',
                displayName: userData.name || userData.username || '',
                profilePicture: userData.avatar_url || userData.picture || ''
            });
        } else {
            // Add new OAuth provider
            account.addOAuthProvider({
                provider,
                providerId: userData.id,
                email: userData.email || '',
                displayName: userData.name || userData.username || '',
                profilePicture: userData.avatar_url || userData.picture || ''
            });
        }

        // Update last login
        account.updateLastLogin(provider);
        await account.save();

        return {
            status: 'success',
            message: `${provider} account linked successfully to your existing account`,
            accountId: account.accountId,
            username: account.username,
            provider: provider,
            isLinked: true
        };
    }

    /**
     * Switch to existing account and link new provider
     * @param {Object} existingAccount - Existing account to switch to
     * @param {string} provider - OAuth provider
     * @param {Object} userData - User data from provider
     * @param {Object} req - Express request object
     */
    async switchToExistingAccount(existingAccount, provider, userData, req) {
        // Link new provider to existing account
        existingAccount.addOAuthProvider({
            provider,
            providerId: userData.id,
            email: userData.email || '',
            displayName: userData.name || userData.username || '',
            profilePicture: userData.avatar_url || userData.picture || ''
        });

        await existingAccount.save();

        // Update session
        req.session.accountId = existingAccount.accountId;
        req.session.loggedIn = true;
        req.session.loginProvider = provider;

        return {
            status: 'success',
            message: 'Switched to existing account',
            accountId: existingAccount.accountId,
            username: existingAccount.username
        };
    }

    /**
     * Merge two accounts (advanced feature)
     * @param {number} primaryAccountId - Primary account to keep
     * @param {number} secondaryAccountId - Secondary account to merge
     * @param {string} provider - OAuth provider
     * @param {Object} userData - User data from provider
     */
    async mergeAccounts(primaryAccountId, secondaryAccountId, provider, userData) {
        // This is a complex operation that would need careful implementation
        // For now, we'll throw an error as this feature needs more planning
        throw new Error('Account merging is not yet implemented');
    }

    /**
     * Initialize session provider flags based on user's connected OAuth providers
     * @param {Object} req - Express request object
     * @param {Object} userProfile - User profile with OAuth providers
     */
    initializeSessionProviderFlags(req, userProfile) {
        if (!userProfile || !userProfile.oauthProviders) {
            return;
        }

        // Set session flags for each connected provider
        if (userProfile.oauthProviders.discord) {
            req.session.discord = true;
        }
        if (userProfile.oauthProviders.google) {
            req.session.google = true;
        }
    }

    /**
     * Get user profile by session
     * @param {Object} req - Express request object
     * @returns {Object|null} User profile or null
     */
    async getUserBySession(req) {
        if (!req.session.loggedIn || !req.session.accountId) {
            return null;
        }

        const userProfile = await userProfileSchema.findOne({ accountId: req.session.accountId });
        
        // Initialize provider flags if they're not set
        if (userProfile && (!req.session.discord && !req.session.google)) {
            this.initializeSessionProviderFlags(req, userProfile);
        }
        
        return userProfile;
    }

    /**
     * Logout user
     * @param {Object} req - Express request object
     */
    logout(req) {
        req.session.destroy();
    }
}

module.exports = AuthenticationHandler;