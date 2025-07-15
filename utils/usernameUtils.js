/**
 * Shared Username Utility Module
 * Provides consistent username validation, sanitization, and conflict resolution
 * across the application (settings page and authentication handler)
 */

const mongolib = require('../mongolib.js');

class UsernameUtils {
    /**
     * Username validation configuration
     */
    static config = {
        minLength: 3,
        maxLength: 32,
        validPattern: /^[a-z0-9_-]+$/,
        sanitizePattern: /[^a-z0-9_-]/g
    };

    /**
     * Sanitize username by converting to lowercase and removing invalid characters
     * @param {string} username - Raw username input
     * @returns {string} Sanitized username
     */
    static sanitizeUsername(username) {
        if (!username || typeof username !== 'string') {
            return '';
        }

        return username
            .toLowerCase()
            .replace(this.config.sanitizePattern, '') // Remove invalid characters
            .substring(0, this.config.maxLength); // Limit length
    }

    /**
     * Validate username format and length
     * @param {string} username - Username to validate
     * @returns {Object} Validation result with isValid boolean and error message
     */
    static validateUsername(username) {
        const result = {
            isValid: false,
            error: null
        };

        if (!username || typeof username !== 'string') {
            result.error = 'Username is required';
            return result;
        }

        const trimmed = username.trim();

        if (trimmed.length < this.config.minLength) {
            result.error = `Username must be at least ${this.config.minLength} characters long`;
            return result;
        }

        if (trimmed.length > this.config.maxLength) {
            result.error = `Username must be no more than ${this.config.maxLength} characters long`;
            return result;
        }

        if (!this.config.validPattern.test(trimmed)) {
            result.error = 'Username can only contain lowercase letters, numbers, underscores, and hyphens';
            return result;
        }

        result.isValid = true;
        return result;
    }

    /**
     * Check if username is available (not taken by another user)
     * @param {string} username - Username to check
     * @param {string} excludeAccountId - Account ID to exclude from check (for current user)
     * @returns {Promise<Object>} Availability result with isAvailable boolean and error message
     */
    static async checkUsernameAvailability(username, excludeAccountId = null) {
        const result = {
            isAvailable: false,
            error: null
        };

        try {
            const existingUser = await mongolib.getSchemaDocumentOnce("userProfile", {
                username: username
            });

            if (existingUser && existingUser.accountId !== excludeAccountId) {
                result.error = 'Username is already taken';
                return result;
            }

            result.isAvailable = true;
            return result;
        } catch (error) {
            result.error = 'Error checking username availability';
            return result;
        }
    }

    /**
     * Generate a unique username by appending numbers if needed
     * @param {string} baseUsername - Base username to make unique
     * @param {string} fallbackPrefix - Prefix to use if base username is too short
     * @returns {Promise<string>} Unique username
     */
    static async ensureUniqueUsername(baseUsername, fallbackPrefix = 'user') {
        let cleanUsername = this.sanitizeUsername(baseUsername);

        // Ensure minimum length with fallback
        if (cleanUsername.length < this.config.minLength) {
            cleanUsername = `${fallbackPrefix}_${Date.now()}`.substring(0, this.config.maxLength);
        }

        let username = cleanUsername;
        let counter = 1;

        // Keep trying until we find a unique username
        while (true) {
            const availability = await this.checkUsernameAvailability(username);
            if (availability.isAvailable) {
                return username;
            }

            // Generate next variant
            const suffix = `_${counter}`;
            const maxBaseLength = this.config.maxLength - suffix.length;
            username = `${cleanUsername.substring(0, maxBaseLength)}${suffix}`;
            counter++;

            // Prevent infinite loop with timestamp fallback
            if (counter > 1000) {
                const timestamp = Date.now().toString().slice(-6);
                username = `${fallbackPrefix}_${timestamp}`;
                break;
            }
        }

        return username;
    }

    /**
     * Update username with booru tag management
     * @param {string} accountId - User's account ID
     * @param {string} newUsername - New username to set
     * @param {string} oldUsername - Current username
     * @returns {Promise<Object>} Update result with success boolean and message
     */
    static async updateUsernameWithBooruTags(accountId, newUsername, oldUsername) {
        const result = {
            success: false,
            message: null
        };

        try {
            // Validate new username
            const validation = this.validateUsername(newUsername);
            if (!validation.isValid) {
                result.message = validation.error;
                return result;
            }

            // Check availability
            const availability = await this.checkUsernameAvailability(newUsername, accountId);
            if (!availability.isAvailable) {
                result.message = availability.error;
                return result;
            }

            // Check if username is the same
            if (newUsername === oldUsername) {
                result.message = 'New username is the same as current username';
                return result;
            }

            // Update booru tags
            await this.updateBooruUsernameTags(accountId, newUsername, oldUsername);

            // Update user profile
            await mongolib.updateSchemaDocumentOnce("userProfile", {
                accountId: accountId
            }, {
                $set: {
                    username: newUsername
                }
            });

            result.success = true;
            result.message = `Username successfully changed to "${newUsername}" and booru tags updated!`;
            return result;

        } catch (error) {
            console.error('Error updating username:', error);
            result.message = 'Error updating username';
            return result;
        }
    }

    /**
     * Update booru tags when username changes
     * @param {string} accountId - User's account ID
     * @param {string} newUsername - New username
     * @param {string} oldUsername - Old username
     * @returns {Promise<void>}
     */
    static async updateBooruUsernameTags(accountId, newUsername, oldUsername) {
        try {
            // Find accounts with old username to determine tag suffix
            const accountsWithOldUsername = await mongolib.aggregateSchemaDocuments("userProfile", [
                { $match: { username: oldUsername } }, 
                { $sort: { timestamp: 1 } }
            ]);

            let usernameCount = 0;
            for (const account of accountsWithOldUsername) {
                if (account.accountId == accountId) {
                    break;
                }
                usernameCount++;
            }

            // Determine the old username tag
            const oldUsernameTag = usernameCount > 0 ? `${oldUsername}-username-${usernameCount}` : `${oldUsername}-username`;

            // Determine the new username tag by checking accounts with new username
            const accountsWithNewUsername = await mongolib.aggregateSchemaDocuments("userProfile", [
                { $match: { username: newUsername } }, 
                { $sort: { timestamp: 1 } }
            ]);

            const newUsernameCount = accountsWithNewUsername.length; // This user will be added to the list
            const newUsernameTag = newUsernameCount > 0 ? `${newUsername}-username-${newUsernameCount}` : `${newUsername}-username`;

            console.log(`Updating booru tags: "${oldUsernameTag}" -> "${newUsernameTag}"`);

            // Update the booru tags - find the old username tag and update it
            const oldUsernameTagDoc = await mongolib.getSchemaDocumentOnce("userBooruTags", {
                tag: oldUsernameTag
            });

            if (oldUsernameTagDoc) {
                console.log(`Found old username tag document with ${oldUsernameTagDoc.booru_ids.length} booru posts`);

                // Create the new username tag or update it if it exists
                const newUsernameTagDoc = await mongolib.getSchemaDocumentOnce("userBooruTags", {
                    tag: newUsernameTag
                });

                if (newUsernameTagDoc) {
                    // Merge the booru_ids from old tag to new tag
                    const combinedBooruIds = [...new Set([...newUsernameTagDoc.booru_ids, ...oldUsernameTagDoc.booru_ids])];
                    await mongolib.updateSchemaDocumentOnce("userBooruTags", {
                        tag: newUsernameTag
                    }, {
                        $set: {
                            count: combinedBooruIds.length.toString(),
                            booru_ids: combinedBooruIds
                        }
                    });
                } else {
                    // Create new username tag with the old tag's data
                    await mongolib.createSchemaDocument("userBooruTags", {
                        tag: newUsernameTag,
                        count: oldUsernameTagDoc.count,
                        booru_ids: oldUsernameTagDoc.booru_ids
                    });
                }

                // Delete the old username tag
                await mongolib.deleteSchemaDocument("userBooruTags", {
                    tag: oldUsernameTag
                });

                console.log(`Successfully updated ${oldUsernameTagDoc.booru_ids.length} booru posts from tag "${oldUsernameTag}" to "${newUsernameTag}"`);
            } else {
                console.log(`No booru posts found with old username tag "${oldUsernameTag}"`);
            }

        } catch (error) {
            console.error('Error updating booru username tags:', error);
            throw error;
        }
    }

    /**
     * Generate clean username from OAuth provider data
     * @param {string} provider - OAuth provider ('discord', 'google')
     * @param {Object} userData - User data from OAuth provider
     * @returns {string} Clean username
     */
    static generateCleanUsernameFromProvider(provider, userData) {
        let username = '';

        if (provider === 'discord') {
            username = userData.username || '';
        } else if (provider === 'google') {
            // Use name or email prefix
            username = userData.name || userData.email?.split('@')[0] || '';
        }

        // Sanitize the username
        let cleanUsername = this.sanitizeUsername(username);

        // Ensure minimum length with fallback
        if (cleanUsername.length < this.config.minLength) {
            cleanUsername = `user_${userData.id || Date.now()}`.substring(0, this.config.maxLength);
        }

        return cleanUsername;
    }
}

module.exports = UsernameUtils;