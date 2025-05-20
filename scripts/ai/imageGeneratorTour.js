// Initialize the tour when DOM is fully loaded
document.addEventListener('DOMContentLoaded', function() {
	// Tour initialization function
	function initTour() {
		// Function to smoothly scroll to an element
		function smoothScrollToElement(element) {
			if (!element) return Promise.resolve();
			
			return new Promise(resolve => {
				// Remove any existing highlights
				document.querySelectorAll('.tour-highlight, .tour-parent-highlight').forEach(el => {
					el.classList.remove('tour-highlight');
					el.classList.remove('tour-parent-highlight');
				});
				
				// Add highlight class to make the element stand out
				element.classList.add('tour-highlight');
				
				// Remove highlight after 7 seconds
				setTimeout(() => {
					element.classList.remove('tour-highlight');
				}, 7000);
				
				const rect = element.getBoundingClientRect();
				
				// More aggressive scrolling - position element higher in viewport
				let scrollTop = rect.top + window.pageYOffset - 100; // Smaller offset to position higher
				window.scrollTo({
					top: scrollTop,
					behavior: 'smooth'
				});
				
				// Faster scroll time
				setTimeout(resolve, 600);
			});
		}
		
		// Initialize tour
		const tour = new Shepherd.Tour({
			defaultStepOptions: {
				cancelIcon: {
					enabled: true
				},
				classes: 'shadow-md bg-purple-dark shepherd-element-zfix',
				scrollTo: false, // Disable built-in scrolling
				modalOverlayOpeningRadius: 8,
				highlightClass: 'shepherd-highlight',
				arrow: false
			},
			useModalOverlay: true,
			exitOnEsc: true,
			confirmCancel: false
		});
		
		// Add z-index fix directly to document
		document.head.insertAdjacentHTML('beforeend', `
		<style>
			/* Fix z-index issues with tour elements */
			.shepherd-element, .shepherd-element-zfix {
				z-index: 101 !important;
				background-color: var(--background-colour) !important;
				color: var(--text-colour) !important;
				border: 1px solid var(--border-colour) !important;
			}
			.shepherd-modal-overlay-container {
				z-index: 90 !important; /* Lower z-index for the overlay */
			}
			
			/* Ensure highlighted elements are above the overlay */
			.tour-highlight {
				position: relative !important;
				z-index: 95 !important; /* Higher than overlay but lower than tooltips */
				box-shadow: 0 0 0 4px var(--highlight-colour), 0 0 15px 5px rgba(0, 0, 0, 0.5) !important;
				border-radius: 4px !important;
				animation: pulse-highlight 1.5s infinite !important;
			}
		</style>
		`);

		// Define the tour steps
		// 1. Welcome step
		tour.addStep({
			id: 'welcome',
			title: 'Welcome to JSCammie!',
			text: 'This guided tour will walk you through each component of the AI image generator.',
			classes: 'shepherd-centered shepherd-element-zfix',
			popperOptions: {
				strategy: 'fixed'
			},
			buttons: [
				{
					text: 'Skip Tour',
					classes: 'shepherd-button-skip',
					action: function() { tour.complete(); }
				},
				{
					text: 'Start Tour',
					classes: 'shepherd-button-primary',
					action: function() { 
						// Find the next element and scroll to it first
						const nextStep = tour.steps[1]; // Index 1 is the second step
						if (nextStep && nextStep.options.attachTo && nextStep.options.attachTo.element) {
							const element = document.querySelector(nextStep.options.attachTo.element);
							if (element) {
								// Scroll directly without using the Promise
								const rect = element.getBoundingClientRect();
								let scrollTop = rect.top + window.pageYOffset - (window.innerHeight / 2) + (rect.height / 2);
								scrollTop += 200; // Add offset
								window.scrollTo({
									top: scrollTop,
									behavior: 'smooth'
								});
								
								// Delay the next step to allow scrolling to complete
								setTimeout(() => {
									tour.next();
								}, 800);
								return;
							}
						}
						tour.next();
					}
				}
			]
		});

		// Helper function to create tour step with custom navigation
		function createTourStep(config) {
			// Store the target element for scrolling
			const targetElement = config.attachTo?.element;
			
			// Override attachTo to center in viewport
			config.attachTo = null;
			
			// Custom buttons that handle scrolling before moving to next/previous step
			config.buttons = [
				{
					text: 'Back',
					action: function() {
						tour.back();
					},
					classes: 'shepherd-button-secondary'
				},
				{
					text: 'Next',
					action: function() {
						// Get the next step's target element
						const currentStepIndex = tour.steps.indexOf(tour.getCurrentStep());
						if (currentStepIndex < tour.steps.length - 1) {
							const nextStepConfig = tour.steps[currentStepIndex + 1];
							const nextTargetEl = document.querySelector(nextStepConfig?.options?.targetElement);
							if (nextTargetEl) {
								// Use the existing smoothScrollToElement function
								smoothScrollToElement(nextTargetEl).then(() => {
									tour.next();
								});
							} else {
								tour.next();
							}
						} else {
							tour.next();
						}
					},
					classes: 'shepherd-button-primary'
				}
			];
			
			// Store the original target element for scrolling
			if (targetElement) {
				config.targetElement = targetElement;
			}
			
			// Center in viewport
			config.popperOptions = {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, 0]
					}
				}],
				strategy: 'fixed'
			};
			
			// Add a fixed position class
			config.classes = (config.classes || '') + ' shepherd-centered';
			
			return config;
		}

		// Add CSS for centered tooltips
		document.head.insertAdjacentHTML('beforeend', `
		<style>
			.shepherd-centered {
				position: fixed !important;
				top: 50% !important;
				left: 50% !important;
				transform: translate(-50%, -50%) !important;
				z-index: 100 !important;
			}
			
			/* Enhanced highlight effect */
			.tour-highlight {
				position: relative !important;
				z-index: 98 !important;
				box-shadow: 0 0 0 4px var(--highlight-colour), 0 0 15px 5px rgba(0, 0, 0, 0.5) !important;
				border-radius: 4px !important;
				animation: pulse-highlight 1.5s infinite !important;
			}
			
			/* Make modal overlay darker to create more contrast */
			.shepherd-modal-overlay-container.shepherd-modal-is-visible {
				opacity: 0.75 !important;
			}
			
			/* Pulse animation for highlight */
			@keyframes pulse-highlight {
				0% { box-shadow: 0 0 0 4px var(--highlight-colour), 0 0 15px 5px rgba(0, 0, 0, 0.5); }
				50% { box-shadow: 0 0 0 8px var(--highlight-colour-hover), 0 0 20px 10px rgba(0, 0, 0, 0.3); }
				100% { box-shadow: 0 0 0 4px var(--highlight-colour), 0 0 15px 5px rgba(0, 0, 0, 0.5); }
			}
		</style>
		`);

		// 2. Prompt
		tour.addStep(createTourStep({
			id: 'prompt',
			title: 'Prompt Input',
			text: 'This is where you describe what you want in your image. The more detailed your prompt, the better! You can use commas to separate different elements, and adjust word emphasis using parentheses.',
			attachTo: {
				element: '#prompt',
				on: 'center'
			},
			popperOptions: {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, window.innerHeight / 3]
					}
				}]
			}
		}));

		// 3. Negative Prompt
		tour.addStep(createTourStep({
			id: 'negativeprompt',
			title: 'Negative Prompt',
			text: 'Here you specify what you DON\'T want in your image. This helps the AI avoid unwanted elements or styles.',
			attachTo: {
				element: '#negativeprompt',
				on: 'top'
			},
			popperOptions: {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, 0]
					}
				}]
			}
		}));

		// 4. Aspect Ratio
		tour.addStep(createTourStep({
			id: 'aspectRatio',
			title: 'Aspect Ratio',
			text: 'Choose the dimensions for your generated image. Different ratios are suited for different purposes (Square, Portrait, Landscape, etc).',
			attachTo: {
				element: '#aspectRatio',
				on: 'top'
			},
			popperOptions: {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, 0]
					}
				}]
			}
		}));

		// 5. Model Selection
		tour.addStep(createTourStep({
			id: 'model',
			title: 'AI Model Selection',
			text: 'Different AI models specialize in generating different styles of images. Choose the one that best fits what you\'re trying to create! Click the "Open Model Selection" button to browse available models.',
			attachTo: {
				element: '.model-select-button',
				on: 'top'
			},
			popperOptions: {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, 0]
					}
				}]
			}
		}));

		// 9. Loras (if they exist)
		if (document.querySelector('.loraContainer')) {
			tour.addStep(createTourStep({
				id: 'loras',
				title: 'LoRA Models',
				text: 'LoRAs are specialized add-ons that can inject specific styles, characters, or concepts into your generations. Use them to fine-tune your results!',
				attachTo: {
					element: '.loraContainer',
					on: 'top'
				},
				popperOptions: {
					modifiers: [{
						name: 'offset',
						options: {
							offset: [0, 0]
						}
					}]
				}
			}));
		}

		// 6. CFG Guidance
		tour.addStep(createTourStep({
			id: 'cfguidance',
			title: 'CFG Guidance Scale',
			text: 'Controls how closely the AI follows your prompt. Higher values make the AI adhere more strictly to your prompt, but might reduce creativity.',
			attachTo: {
				element: '#cfguidance',
				on: 'top'
			},
			popperOptions: {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, 0]
					}
				}]
			}
		}));

		// 7. Seed
		tour.addStep(createTourStep({
			id: 'seed',
			title: 'Generation Seed',
			text: 'A seed value determines the initial randomness. Using the same seed with the same settings will produce similar results. Use -1 for a random seed each time.',
			attachTo: {
				element: '#seed',
				on: 'top'
			},
			popperOptions: {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, 0]
					}
				}]
			}
		}));

		// 8. Generate Button
		tour.addStep(createTourStep({
			id: 'generate',
			title: 'Generate Image',
			text: 'Click this button when you\'re ready to create your image!',
			attachTo: {
				element: '#generateButton',
				on: 'top'
			},
			popperOptions: {
				modifiers: [{
					name: 'offset',
					options: {
						offset: [0, 0]
					}
				}]
			}
		}));

		// 10. Final step
		tour.addStep({
			id: 'complete',
			title: 'You\'re Ready to Create!',
			text: 'You now know how to use the AI image generator. Experiment with different settings to get the perfect image! If you need this tour again, click the "Take a Tour" button.',
			buttons: [
				{
					text: 'Finish',
					classes: 'shepherd-button-primary',
					action: function() { tour.complete(); }
				}
			]
		});

		return tour;
	}

	// Create tour button functionality
	const tourButton = document.getElementById('startTourButton');
	
	// Function to add global tour styles
	function addTourGlobalStyles() {
		if (!document.getElementById('tour-global-styles')) {
			const styleEl = document.createElement('style');
			styleEl.id = 'tour-global-styles';
			styleEl.textContent = `
				/* Make form elements appear above overlay during tour */
				body.tour-active #prompt,
				body.tour-active #negativeprompt,
				body.tour-active #aspectRatio,
				body.tour-active .model-select-button,
				body.tour-active #cfguidance,
				body.tour-active #seed,
				body.tour-active #generateButton,
				body.tour-active .loraContainer {
					position: relative !important;
					z-index: 95 !important;
				}
				
				/* Lower the modal overlay z-index */
				body.tour-active .shepherd-modal-overlay-container.shepherd-modal-is-visible {
					z-index: 90 !important;
					background-color: var(--darker-background-colour) !important;
					opacity: 0.8 !important;
				}

				/* Ensure tour elements use theme colors */
				body.tour-active .shepherd-element {
					background-color: var(--background-colour) !important;
					color: var(--text-colour) !important;
					border: 1px solid var(--border-colour) !important;
				}

				body.tour-active .shepherd-text {
					color: var(--text-colour) !important;
				}

				body.tour-active .shepherd-title {
					color: var(--text-colour) !important;
				}
			`;
			document.head.appendChild(styleEl);
		}
	}
	
	// Function to prepare and start tour
	function prepareTourAndStart() {
		// Add class to body for z-index control
		document.body.classList.add('tour-active');
		// Add global styles
		addTourGlobalStyles();
		// Start tour
		const tour = initTour();
		tour.start();
	}
	
	if (tourButton) {
		tourButton.addEventListener('click', function() {
			prepareTourAndStart();
		});
	}
	
	// Clean up when tour ends
	Shepherd.on('complete', function() {
		document.body.classList.remove('tour-active');
	});
	
	Shepherd.on('cancel', function() {
		document.body.classList.remove('tour-active');
	});
	
	// Optional: Auto-start tour for first-time visitors
	// You can use localStorage to check if this is their first visit
	if (!localStorage.getItem('tourShown')) {
		// Delay the tour to ensure page is fully loaded
		setTimeout(function() {
			prepareTourAndStart();
			localStorage.setItem('tourShown', 'true');
		}, 1500);
	}
});
